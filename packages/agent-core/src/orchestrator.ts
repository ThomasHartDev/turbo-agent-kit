import type { LLMProvider } from "./llm-provider";
import type { Conversation, Message } from "./types";
import { toolRegistry, toolSpecsFrom, type Tool } from "./tools";
import type { Telemetry } from "./telemetry";

export const MAX_STEPS = 5;

export interface TurnHooks {
  onMessage?: (m: Message) => void;
  /** Swap the default registry (tests, alternate skill packs). */
  tools?: ReadonlyMap<string, Tool>;
  maxSteps?: number;
}

export async function runAgentTurn(
  conversation: Conversation,
  userText: string,
  llm: LLMProvider,
  telemetry: Telemetry,
  hooks: TurnHooks = {},
): Promise<void> {
  const registry = hooks.tools ?? toolRegistry;
  const maxSteps = hooks.maxSteps ?? MAX_STEPS;
  const specs = toolSpecsFrom(registry);

  const push = (m: Message) => {
    conversation.messages.push(m);
    hooks.onMessage?.(m);
  };

  push({ role: "user", content: userText });

  for (let step = 0; step < maxSteps; step++) {
    const t0 = performance.now();
    const result = await llm.complete(conversation.messages, specs);
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

    const tool = registry.get(result.toolCall.name);
    const tt0 = performance.now();
    let output: string;
    try {
      output = tool
        ? await tool.run(result.toolCall.args)
        : `Unknown tool: ${result.toolCall.name}`;
    } catch (err) {
      // Keep the turn alive: models often recover when the error is in context.
      const message = err instanceof Error ? err.message : String(err);
      output = `Tool error: ${message}`;
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
