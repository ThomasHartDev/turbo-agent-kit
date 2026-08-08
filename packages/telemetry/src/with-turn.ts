import { SpanKind, SpanStatusCode, type Attributes, type Exception } from "@opentelemetry/api";
import { getTracer } from "./init";

export interface AgentTurnAttrs {
  conversationId?: string;
  channel?: string;
  requestId?: string;
  messageLength?: number;
}

/** Root span for one HTTP agent turn; LLM/tool spans nest via context. */
export async function withAgentTurn<T>(attrs: AgentTurnAttrs, fn: () => Promise<T>): Promise<T> {
  const attributes: Attributes = {};
  if (attrs.conversationId) attributes["agent.conversation_id"] = attrs.conversationId;
  if (attrs.channel) attributes["agent.channel"] = attrs.channel;
  if (attrs.requestId) attributes["agent.request_id"] = attrs.requestId;
  if (attrs.messageLength !== undefined) {
    attributes["agent.message_length"] = attrs.messageLength;
  }

  return getTracer().startActiveSpan(
    "agent.turn",
    { kind: SpanKind.SERVER, attributes },
    async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Exception);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
