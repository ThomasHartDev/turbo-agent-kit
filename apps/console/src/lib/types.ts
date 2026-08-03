export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface TelemetrySnapshot {
  events: number;
  all: LatencySummary;
  llm: LatencySummary;
  tool: LatencySummary;
}

export type AgentStreamEvent =
  | { type: "meta"; conversationId: string; channel: string }
  | { type: "message"; message: ChatMessage }
  | { type: "done"; conversationId: string }
  | { type: "error"; error: string; detail?: string }
  | { type: "http_error"; status: number; message: string };
