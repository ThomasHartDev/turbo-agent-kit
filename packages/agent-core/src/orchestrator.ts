import type { LLMProvider } from "./llm-provider";
import type { Conversation, Message } from "./types";
import { toolRegistry, toolSpecs } from "./tools";
import type { Telemetry } from "./telemetry";

const MAX_STEPS = 5;

export interface TurnHooks {
  // let's the caller watch messages as they're produced mid-turn
  onMessage?: (m: Message) => void;
}

export async function runAgentTurn(
  conversation: Conversation,
  userText: string,
  llm: LLMProvider,
  telemetry: Telemetry,
  hooks: TurnHooks = {},
): Promise<void> {
  const push = (m: Message) => {
    conversation.messages.push(m);
    hooks.onMessage?.(m);
  };

  push({ role: "user", content: userText });

  for (let step = 0; step < MAX_STEPS; step++) {
    const t0 = performance.now();
    const result = await llm.complete(conversation.messages, toolSpecs);
    telemetry.record({
      type: "llm",
      channel: conversation.channel,
      ms: performance.now() - t0,
      detail: result.kind,
    });

    if (result.kind === "final") {
      push({ role: "assistant", content: result.content });
      return;
    }

    push({
      role: "assistant",
      content: `calling ${result.toolCall.name}(${JSON.stringify(result.toolCall.args)})`,
      toolCall: result.toolCall,
    });

    const tool = toolRegistry.get(result.toolCall.name);
    const tt0 = performance.now();
    let output: string;
    try {
      output = tool ? await tool.run(result.toolCall.args) : `Unknown tool: ${result.toolCall.name}`;
    } catch (err) {
      output = `Tool error: ${(err as Error).message}`;
    }
    telemetry.record({
      type: "tool",
      channel: conversation.channel,
      ms: performance.now() - tt0,
      detail: result.toolCall.name,
    });

    push({ role: "tool", content: output, toolCallId: result.toolCall.id });
  }

  push({ role: "assistant", content: "Sorry, I could not complete that request" });
}
