import { describe, it, expect } from "vitest";
import { runAgentTurn } from "./orchestrator";
import { MockLLMProvider } from "./llm-provider";
import { InMemoryConversationStore } from "./store";
import { Telemetry } from "./telemetry";
import type { LLMProvider, LLMResult } from "./llm-provider";

function setup() {
  return {
    llm: new MockLLMProvider(),
    telemetry: new Telemetry(),
    convo: new InMemoryConversationStore().create("chat"),
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

  it("stops at MAX_STEPS if a provider loops forever", async () => {
    const loopingLLM: LLMProvider = {
      name: "looping",
      async complete(): Promise<LLMResult> {
        return {
          kind: "tool",
          toolCall: { id: crypto.randomUUID(), name: "checkAvailability", args: { date: "x" } },
        };
      },
    };
    const { telemetry, convo } = setup();
    await runAgentTurn(convo, "loop", loopingLLM, telemetry);
    expect(convo.messages.at(-1)!.content).toContain("could not complete");
  });
});
