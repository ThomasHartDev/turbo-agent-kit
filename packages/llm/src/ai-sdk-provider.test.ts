import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import type { Message } from "@agent/core";
import { AiSdkLLMProvider } from "./ai-sdk-provider";
import { createLLMProvider } from "./factory";

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const specs = [{ name: "checkAvailability", description: "check open slots" }];

function textModel(text: string) {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage,
      warnings: [],
    }),
  });
}

function toolModel(name: string, args: Record<string, unknown>) {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [
        { type: "tool-call", toolCallId: "call-1", toolName: name, input: JSON.stringify(args) },
      ],
      finishReason: "tool-calls",
      usage,
      warnings: [],
    }),
  });
}

describe("AiSdkLLMProvider", () => {
  it("surfaces a plain answer as a final result", async () => {
    const provider = new AiSdkLLMProvider({ model: textModel("we open at nine") });
    const result = await provider.complete([{ role: "user", content: "hi" }], specs);
    expect(result).toEqual({ kind: "final", content: "we open at nine" });
  });

  it("surfaces a tool call with parsed args", async () => {
    const provider = new AiSdkLLMProvider({
      model: toolModel("checkAvailability", { date: "tomorrow" }),
    });
    const result = await provider.complete([{ role: "user", content: "are you open?" }], specs);
    expect(result).toEqual({
      kind: "tool",
      toolCall: { id: "call-1", name: "checkAvailability", args: { date: "tomorrow" } },
    });
  });

  it("names the model from its modelId", () => {
    const provider = new AiSdkLLMProvider({
      model: new MockLanguageModelV2({ modelId: "gpt-test" }),
    });
    expect(provider.name).toBe("gpt-test");
  });

  it("rebuilds the tool name for a prior tool result when replaying history", async () => {
    const model = toolModel("checkAvailability", { date: "friday" });
    const provider = new AiSdkLLMProvider({ model });
    const history: Message[] = [
      { role: "user", content: "are you open?" },
      {
        role: "assistant",
        content: "calling checkAvailability",
        toolCall: { id: "prev-1", name: "checkAvailability", args: { date: "today" } },
      },
      { role: "tool", content: "Open slots today: 9am", toolCallId: "prev-1" },
    ];

    await provider.complete(history, specs);

    const prompt = model.doGenerateCalls[0]!.prompt;
    const toolMsg = prompt.find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({
      toolCallId: "prev-1",
      toolName: "checkAvailability",
    });
  });
});

describe("createLLMProvider", () => {
  const savedKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  it("falls back to the mock provider without a key", () => {
    const provider = createLLMProvider();
    expect(provider.name).toBe("mock-model");
  });

  it("builds the AI SDK adapter when a key is supplied", () => {
    const provider = createLLMProvider({ apiKey: "sk-test", model: "gpt-4o-mini" });
    expect(provider).toBeInstanceOf(AiSdkLLMProvider);
    expect(provider.name).toBe("gpt-4o-mini");
  });
});
