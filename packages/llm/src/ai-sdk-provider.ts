import {
  generateText,
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { LLMProvider, LLMResult, Message, ToolSpec } from "@agent/core";

export interface AiSdkProviderOptions {
  model: LanguageModel;
  system?: string;
}

export class AiSdkLLMProvider implements LLMProvider {
  readonly name: string;
  private readonly model: LanguageModel;
  private readonly system?: string;

  constructor(opts: AiSdkProviderOptions) {
    this.model = opts.model;
    this.system = opts.system;
    this.name = typeof opts.model === "string" ? opts.model : opts.model.modelId;
  }

  async complete(messages: Message[], tools: ToolSpec[]): Promise<LLMResult> {
    const { text, toolCalls } = await generateText({
      model: this.model,
      system: this.system,
      messages: toModelMessages(messages),
      tools: toToolSet(tools),
    });

    // The orchestrator drives the loop, so we surface at most one decision per call.
    const call = toolCalls[0];
    if (call) {
      return {
        kind: "tool",
        toolCall: { id: call.toolCallId, name: call.toolName, args: asArgs(call.input) },
      };
    }
    return { kind: "final", content: text };
  }
}

// ToolSpec carries no parameter schema, so accept any JSON object and let the tool validate.
const anyObject = jsonSchema<Record<string, unknown>>({
  type: "object",
  additionalProperties: true,
});

function toToolSet(specs: ToolSpec[]): ToolSet {
  const entries = specs.map(
    (s) => [s.name, tool({ description: s.description, inputSchema: anyObject })] as const,
  );
  return Object.fromEntries(entries);
}

function toModelMessages(messages: Message[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.toolCall) toolNames.set(m.toolCall.id, m.toolCall.name);
  }

  return messages.map((m): ModelMessage => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        if (m.toolCall) {
          return {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: m.toolCall.id,
                toolName: m.toolCall.name,
                input: m.toolCall.args,
              },
            ],
          };
        }
        return { role: "assistant", content: m.content };
      case "tool": {
        const id = m.toolCallId ?? "";
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: id,
              toolName: toolNames.get(id) ?? "unknown",
              output: { type: "text", value: m.content },
            },
          ],
        };
      }
    }
  });
}

function asArgs(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}
