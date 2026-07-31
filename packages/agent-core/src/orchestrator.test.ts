import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgentTurn, MAX_STEPS } from "./orchestrator";
import { MockLLMProvider } from "./llm-provider";
import { InMemoryConversationStore } from "./store";
import { Telemetry } from "./telemetry";
import { defineTool, createToolRegistry } from "./tools";
import type { LLMProvider, LLMResult } from "./llm-provider";

function setup() {
  return {
    llm: new MockLLMProvider(),
    telemetry: new Telemetry(),
    convo: new InMemoryConversationStore().create("chat"),
  };
}

function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return {
    name: "scripted",
    async complete(): Promise<LLMResult> {
      const next = results[i] ?? results[results.length - 1]!;
      i += 1;
      return next;
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>): LLMResult {
  return {
    kind: "tool",
    toolCall: { id: crypto.randomUUID(), name, args },
  };
}

describe("runAgentTurn", () => {
  it("calls a tool then produces a final answer", async () => {
    const { llm, telemetry, convo } = setup();
    await runAgentTurn(convo, "book an appointment", llm, telemetry);

    const roles = convo.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(convo.messages.at(-1)!.content).toContain("Booked");
    expect(telemetry.all().filter((e) => e.type === "tool")).toHaveLength(1);
  });

  it("answers directly when no tool is needed", async () => {
    const { llm, telemetry, convo } = setup();
    await runAgentTurn(convo, "hello there", llm, telemetry);
    expect(convo.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(telemetry.all().filter((e) => e.type === "tool")).toHaveLength(0);
  });

  it("feeds Zod validation failures back as tool content and continues", async () => {
    const { telemetry, convo } = setup();
    const llm = scriptedLLM([
      toolCall("calculate", { a: "nope", b: 2, op: "+" }),
      { kind: "final", content: "I need two numbers" },
    ]);

    await runAgentTurn(convo, "add stuff", llm, telemetry);

    const toolMsg = convo.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/^Invalid arguments for calculate:/);
    expect(toolMsg?.content).toContain("a:");
    expect(convo.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "I need two numbers",
    });
    // Validation still counts as a tool span (boundary work ran).
    expect(telemetry.all().filter((e) => e.type === "tool")).toHaveLength(1);
  });

  it("converts runtime tool throws into Tool error messages", async () => {
    const { telemetry, convo } = setup();
    const llm = scriptedLLM([
      toolCall("calculate", { a: 1, b: 0, op: "/" }),
      { kind: "final", content: "cannot divide by zero" },
    ]);

    await runAgentTurn(convo, "divide", llm, telemetry);

    const toolMsg = convo.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("Tool error: division by zero");
    expect(convo.messages.at(-1)?.content).toBe("cannot divide by zero");
  });

  it("reports unknown tools without throwing", async () => {
    const { telemetry, convo } = setup();
    const llm = scriptedLLM([
      toolCall("teleport", { where: "mars" }),
      { kind: "final", content: "no such tool" },
    ]);

    await runAgentTurn(convo, "teleport me", llm, telemetry);

    expect(convo.messages.find((m) => m.role === "tool")?.content).toBe("Unknown tool: teleport");
    expect(convo.messages.at(-1)?.content).toBe("no such tool");
  });

  it("stops at MAX_STEPS if a provider loops forever", async () => {
    const loopingLLM: LLMProvider = {
      name: "looping",
      async complete(): Promise<LLMResult> {
        return toolCall("checkAvailability", { date: "x" });
      },
    };
    const { telemetry, convo } = setup();
    await runAgentTurn(convo, "loop", loopingLLM, telemetry);

    expect(convo.messages.at(-1)!.content).toContain("could not complete");
    const toolMsgs = convo.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(MAX_STEPS);
    expect(telemetry.all().filter((e) => e.type === "llm")).toHaveLength(MAX_STEPS);
    expect(telemetry.all().filter((e) => e.type === "tool")).toHaveLength(MAX_STEPS);
  });

  it("honors a lower maxSteps override", async () => {
    const loopingLLM: LLMProvider = {
      name: "looping",
      async complete(): Promise<LLMResult> {
        return toolCall("calculate", { a: 1, b: 1, op: "+" });
      },
    };
    const { telemetry, convo } = setup();
    await runAgentTurn(convo, "loop", loopingLLM, telemetry, { maxSteps: 2 });

    expect(convo.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(convo.messages.at(-1)!.content).toContain("could not complete");
  });

  it("accepts an injected tool registry", async () => {
    const custom = defineTool({
      name: "ping",
      description: "pong",
      schema: z.object({}),
      async run() {
        return "pong";
      },
    });
    const registry = createToolRegistry([custom]);
    const llm = scriptedLLM([toolCall("ping", {}), { kind: "final", content: "done" }]);
    const { telemetry, convo } = setup();

    await runAgentTurn(convo, "ping", llm, telemetry, { tools: registry });

    expect(convo.messages.find((m) => m.role === "tool")?.content).toBe("pong");
    expect(convo.messages.at(-1)?.content).toBe("done");
  });
});
