import type { ChatMessage } from "./types";

export type ChatStatus = "idle" | "loading" | "streaming" | "error";

export interface ChatState {
  messages: ChatMessage[];
  conversationId: string | null;
  status: ChatStatus;
  error: string | null;
  draft: string;
}

export type ChatAction =
  | { type: "set_draft"; draft: string }
  | { type: "submit" }
  | { type: "meta"; conversationId: string }
  | { type: "message"; message: ChatMessage }
  | { type: "done" }
  | { type: "fail"; error: string }
  | { type: "reset" };

export const initialChatState: ChatState = {
  messages: [],
  conversationId: null,
  status: "idle",
  error: null,
  draft: "",
};

export function isEmpty(state: ChatState): boolean {
  return state.messages.length === 0 && state.status === "idle" && state.error === null;
}

export function canSubmit(state: ChatState): boolean {
  return (
    state.draft.trim().length > 0 && state.status !== "loading" && state.status !== "streaming"
  );
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "set_draft":
      return { ...state, draft: action.draft };
    case "submit":
      if (!canSubmit(state)) return state;
      return { ...state, draft: "", status: "loading", error: null };
    case "meta":
      return { ...state, conversationId: action.conversationId, status: "streaming" };
    case "message":
      return {
        ...state,
        status: "streaming",
        messages: [...state.messages, action.message],
      };
    case "done":
      return { ...state, status: "idle", error: null };
    case "fail":
      return { ...state, status: "error", error: action.error };
    case "reset":
      return { ...initialChatState };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
