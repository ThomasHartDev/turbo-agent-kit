import { iterateSseStream } from "./sse";
import type { AgentStreamEvent, ChatMessage, TelemetrySnapshot } from "./types";

export interface AgentClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

function url(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string;
      detail?: string;
      retryAfterMs?: number;
    };
    if (body.error === "rate_limited" && typeof body.retryAfterMs === "number") {
      return `Rate limited. Retry after ${body.retryAfterMs}ms.`;
    }
    if (body.detail) return `${body.error ?? "error"}: ${body.detail}`;
    if (body.error) return body.error;
  } catch {
    /* non-JSON */
  }
  return `HTTP ${res.status}`;
}

export async function* streamAgentTurn(
  body: { message: string; conversationId?: string },
  options: AgentClientOptions = {},
): AsyncGenerator<AgentStreamEvent> {
  const baseUrl = options.baseUrl ?? "/api/agent";
  const fetchImpl = options.fetch ?? fetch;
  const res = await fetchImpl(url(baseUrl, "/turn"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    yield { type: "http_error", status: res.status, message: await errorMessage(res) };
    return;
  }
  if (!res.body) {
    yield { type: "http_error", status: res.status, message: "empty response body" };
    return;
  }

  for await (const frame of iterateSseStream(res.body)) {
    let data: unknown;
    try {
      data = frame.data === "" ? null : JSON.parse(frame.data);
    } catch {
      yield { type: "error", error: "invalid_sse_json", detail: frame.data };
      continue;
    }
    const o = data as Record<string, unknown> | null;
    if (frame.event === "meta") {
      yield {
        type: "meta",
        conversationId: String(o?.conversationId ?? ""),
        channel: String(o?.channel ?? "chat"),
      };
    } else if (frame.event === "message") {
      yield {
        type: "message",
        message: {
          role: (o?.role as ChatMessage["role"]) ?? "assistant",
          content: String(o?.content ?? ""),
        },
      };
    } else if (frame.event === "done") {
      yield { type: "done", conversationId: String(o?.conversationId ?? "") };
    } else if (frame.event === "error") {
      yield {
        type: "error",
        error: String(o?.error ?? "turn_failed"),
        detail: typeof o?.detail === "string" ? o.detail : undefined,
      };
    }
  }
}

export async function fetchTelemetry(options: AgentClientOptions = {}): Promise<TelemetrySnapshot> {
  const baseUrl = options.baseUrl ?? "/api/agent";
  const fetchImpl = options.fetch ?? fetch;
  const res = await fetchImpl(url(baseUrl, "/telemetry"), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as TelemetrySnapshot;
}
