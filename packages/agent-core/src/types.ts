export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  toolCall?: ToolCall;
  toolCallId?: string;
}

export type Channel = "chat" | "sms" | "voice";

export interface Conversation {
  id: string;
  channel: Channel;
  messages: Message[];
}
