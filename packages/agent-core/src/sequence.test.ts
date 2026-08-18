import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockLLMProvider, type LLMProvider, type LLMResult } from "./llm-provider";
import { MAX_STEPS, TURN_BUDGET_MESSAGE, runAgentTurn, type TurnHooks } from "./orchestrator";
import {
  AGENT_LOOP_DIAGRAM,
  acceptsTrace,
  assertWellFormed,
  toMermaid,
  type LoopEvent,
  type SequenceDiagram,
  type SequenceMessage,
} from "./sequence";
import { InMemoryConversationStore } from "./store";
import { Telemetry } from "./telemetry";

function diagram(over: Partial<SequenceDiagram>): SequenceDiagram {
  return {
    participants: [
      { id: "A", label: "A" },
      { id: "B", label: "B" },
    ],
    steps: [{ kind: "sync", from: "A", to: "B", label: "ping" }],
    ...over,
  };
}

function ping(extra: Partial<SequenceMessage> = {}): SequenceMessage {
  return { kind: "sync", from: "A", to: "B", label: "x", ...extra };
}

async function record(text: string, llm: LLMProvider, hooks: TurnHooks = {}): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  const wrapped: LLMProvider = {
    name: llm.name,
    async complete(messages, tools) {
      const result = await llm.complete(messages, tools);
      events.push("llm");
      return result;
    },
  };
  await runAgentTurn(
    new InMemoryConversationStore().create("chat"),
    text,
    wrapped,
    new Telemetry(),
    {
      ...hooks,
      onMessage(m) {
        if (m.role === "user") events.push("user");
        else if (m.role === "tool") events.push("tool_result");
        else if (m.role === "assistant" && m.toolCall) events.push("tool_call");
        else if (m.role === "assistant") {
          events.push(m.content === TURN_BUDGET_MESSAGE ? "give_up" : "final");
        }
      },
    },
  );
  return events;
}

describe("sequence well-formedness", () => {
  it("accepts the agent-loop diagram", () => {
    expect(() => assertWellFormed(AGENT_LOOP_DIAGRAM)).not.toThrow();
  });

  it.each<[string, SequenceDiagram, RegExp]>([
    ["no participants", diagram({ participants: [] }), /no participants/],
    ["unknown end", diagram({ steps: [ping({ to: "Z" })] }), /unknown to Z/],
    ["empty loop", diagram({ steps: [{ kind: "loop", label: "x", body: [] }] }), /empty fragment/],
    ["over-deactivate", diagram({ steps: [ping({ deactivate: "to" })] }), /idle B/],
    [
      "loop leak",
      diagram({ steps: [{ kind: "loop", label: "x", body: [ping({ activate: "to" })] }] }),
      /leaks activation/,
    ],
    [
      "unbalanced alt",
      diagram({
        steps: [
          {
            kind: "alt",
            branches: [
              { label: "yes", body: [ping({ activate: "to" })] },
              { label: "no", body: [ping()] },
            ],
          },
        ],
      }),
      /different activations/,
    ],
  ])("rejects %s", (_name, d, re) => {
    expect(() => assertWellFormed(d)).toThrow(re);
  });
});

describe("toMermaid", () => {
  it("renders the loop, alt, and activations", () => {
    const src = toMermaid(AGENT_LOOP_DIAGRAM);
    expect(src).toMatch(
      /sequenceDiagram[\s\S]*loop step < maxSteps[\s\S]*alt final[\s\S]*else tool_call/,
    );
    expect(src).toContain("Agent->>LLM: complete(history, specs)");
    expect(src).toContain("activate LLM");
  });

  it("escapes colons in labels", () => {
    expect(toMermaid(diagram({ steps: [ping({ label: "k: v" })] }))).toContain("A->>B: k; v");
  });

  it("locks packages/agent-core/README.md to toMermaid", () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(dir, "pnpm-workspace.yaml"))) dir = dirname(dir);
    const readme = readFileSync(join(dir, "packages/agent-core/README.md"), "utf8");
    expect(readme.match(/```mermaid\n([\s\S]*?)```/)?.[1]).toBe(toMermaid(AGENT_LOOP_DIAGRAM));
  });
});

describe("acceptsTrace", () => {
  const budget: LoopEvent[] = ["user"];
  for (let i = 0; i < 5; i++) budget.push("llm", "tool_call", "tool_result");
  budget.push("give_up");

  it.each<[boolean, LoopEvent[], number]>([
    [true, ["user", "llm", "final"], 5],
    [true, ["user", "llm", "tool_call", "tool_result", "llm", "final"], 5],
    [true, budget, 5],
    [false, [], 5],
    [false, ["llm", "final"], 5],
    [false, ["user", "llm", "give_up"], 5],
    [false, ["user", "llm", "final", "llm"], 5],
    [false, ["user", "llm", "tool_call", "llm"], 5],
    [false, ["user", "llm", "tool_call", "tool_result", "give_up"], 5],
  ])("%s %j max=%i", (ok, events, max) => {
    expect(acceptsTrace(events, max)).toBe(ok);
  });
});

describe("live traces match the protocol", () => {
  it("covers final, tool, and budget exhaustion", async () => {
    const llm = new MockLLMProvider();
    const direct = await record("hello", llm);
    expect(direct).toEqual(["user", "llm", "final"]);
    expect(acceptsTrace(direct, MAX_STEPS)).toBe(true);

    const booked = await record("book an appointment", llm);
    expect(booked).toEqual(["user", "llm", "tool_call", "tool_result", "llm", "final"]);
    expect(acceptsTrace(booked, MAX_STEPS)).toBe(true);

    const looping: LLMProvider = {
      name: "loop",
      async complete(): Promise<LLMResult> {
        return {
          kind: "tool",
          toolCall: { id: "t", name: "checkAvailability", args: { date: "x" } },
        };
      },
    };
    const events = await record("loop", looping, { maxSteps: 2 });
    expect(events).toEqual([
      "user",
      "llm",
      "tool_call",
      "tool_result",
      "llm",
      "tool_call",
      "tool_result",
      "give_up",
    ]);
    expect(acceptsTrace(events, 2)).toBe(true);
  });
});

describe("package READMEs", () => {
  it("requires a README titled after package.json name", () => {
    let root = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(root, "pnpm-workspace.yaml"))) root = dirname(root);
    const dirs = readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, "packages", e.name));
    for (const dir of dirs) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string };
      const text = readFileSync(join(dir, "README.md"), "utf8");
      expect(text.split("\n")[0], pkg.name).toBe(`# ${pkg.name}`);
      expect(text, pkg.name).toMatch(/## Tests/);
    }
  });
});
