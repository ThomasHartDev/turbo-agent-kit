import type { AgentStreamEvent } from "./types";
import type { ChatAction } from "./chat-state";

export type StreamFailInput =
  Extract<AgentStreamEvent, { type: "error" | "http_error" }> | { type: "stream_closed" };

// WHY: HTTP fail always restores draft; mid-stream SSE error after a message frame must not
// (server already emitted the user turn). 404 drops dead conversationId so retries don't loop.
export function failActionForStreamEvent(
  event: StreamFailInput,
  draftMessage: string,
  receivedMessage: boolean,
): Extract<ChatAction, { type: "fail" }> {
  if (event.type === "http_error") {
    const clearConversation = event.status === 404 || isConversationNotFound(event.message);
    return {
      type: "fail",
      error: event.message,
      restoreDraft: draftMessage,
      ...(clearConversation ? { clearConversation: true } : {}),
    };
  }

  const error =
    event.type === "error"
      ? event.detail
        ? `${event.error}: ${event.detail}`
        : event.error
      : "stream closed before done";

  return {
    type: "fail",
    error,
    ...(receivedMessage ? {} : { restoreDraft: draftMessage }),
  };
}

function isConversationNotFound(message: string): boolean {
  return message === "conversation_not_found" || message.startsWith("conversation_not_found:");
}
