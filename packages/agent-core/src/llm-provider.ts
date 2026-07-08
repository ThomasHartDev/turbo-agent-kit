import type { Message, ToolCall } from "./types";
import type { ToolSpec } from "./tools"; // Don't need .js imports with moduleResolution: "bundler"
import { sleep } from "./utils";

export type LLMResult = { kind: "final"; content: string } | { kind: "tool"; toolCall: ToolCall };

export interface LLMProvider {
  name: string;
  complete(messages: Message[], tools: ToolSpec[]): Promise<LLMResult>;
}

export class MockLLMProvider implements LLMProvider {
  name = "mock-model";

  async complete(messages: Message[], _tools: ToolSpec[]): Promise<LLMResult> {
    await sleep(150 + Math.random() * 250);

    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    const thisTurn = messages.slice(lastUserIdx);

    const toolThisTurn = thisTurn.find((m) => m.role === "tool");
    if (toolThisTurn) return { kind: "final", content: toolThisTurn.content };

    const lastUser = messages[lastUserIdx]?.content.toLowerCase() ?? "";

    if (lastUser.includes("book") || lastUser.includes("appointment")) {
      // Real model reads the whole message and decides intent from meaning. These hard coded strings are stand ins
      return {
        kind: "tool",
        toolCall: {
          id: crypto.randomUUID(),
          name: "bookAppointment",
          args: { service: "oil change", time: "tomorrow 9am" },
        },
      };
    }
    if (lastUser.includes("hours") || lastUser.includes("open") || lastUser.includes("available")) {
      return {
        kind: "tool",
        toolCall: {
          id: crypto.randomUUID(),
          name: "checkAvailability",
          args: { date: "tomorrow" },
        },
      };
    }

    return {
      kind: "final",
      content: "Happy to help. I can check availability or book an appointment. Which would you like?",
    };
  }
}
