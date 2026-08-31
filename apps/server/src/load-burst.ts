import { percentileOf, type LatencySummary } from "@agent/core";
import type { App } from "./create-app";

export interface SseEvent {
  event: string;
  data: string;
}

export interface LoadSample {
  status: number;
  durationMs: number;
  contentType: string;
  retryAfter: string | null;
  remaining: string | null;
  events: SseEvent[];
}

export interface BurstOptions {
  n: number;
  message?: string | ((index: number) => string);
}

export interface BurstResult {
  samples: LoadSample[];
  admitted: number;
  rejected: number;
  other: number;
  latency: {
    all: LatencySummary;
    admitted: LatencySummary;
    rejected: LatencySummary;
  };
}

export function parseSseFrames(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  const normalized = body.replace(/\r\n/g, "\n");
  for (const block of normalized.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    let event = "message";
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0 && event === "message") continue;
    events.push({ event, data: data.join("\n") });
  }
  return events;
}

export function latencySummary(durationsMs: readonly number[]): LatencySummary {
  const xs = [...durationsMs].sort((a, b) => a - b);
  return {
    count: xs.length,
    p50: percentileOf(xs, 50),
    p95: percentileOf(xs, 95),
    p99: percentileOf(xs, 99),
  };
}

export function summarizeBurst(samples: readonly LoadSample[]): BurstResult {
  const admitted = samples.filter((s) => s.status === 200);
  const rejected = samples.filter((s) => s.status === 429);
  return {
    samples: [...samples],
    admitted: admitted.length,
    rejected: rejected.length,
    other: samples.length - admitted.length - rejected.length,
    latency: {
      all: latencySummary(samples.map((s) => s.durationMs)),
      admitted: latencySummary(admitted.map((s) => s.durationMs)),
      rejected: latencySummary(rejected.map((s) => s.durationMs)),
    },
  };
}

function expandRequests(options: BurstOptions): string[] {
  if (!Number.isInteger(options.n) || options.n < 0) {
    throw new RangeError(`n must be a non-negative integer, got ${options.n}`);
  }
  const message = options.message ?? "hello";
  return Array.from({ length: options.n }, (_, i) =>
    typeof message === "function" ? message(i) : message,
  );
}

async function oneTurn(app: App, message: string): Promise<LoadSample> {
  const t0 = performance.now();
  const res = await app.request("/agent/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const text = await res.text();
  const durationMs = Math.round(performance.now() - t0);
  const contentType = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    durationMs,
    contentType,
    retryAfter: res.headers.get("Retry-After"),
    remaining: res.headers.get("X-RateLimit-Remaining"),
    events: contentType.includes("text/event-stream") ? parseSseFrames(text) : [],
  };
}

export async function fireTurnBurst(app: App, options: BurstOptions): Promise<BurstResult> {
  const messages = expandRequests(options);
  const samples = await Promise.all(messages.map((message) => oneTurn(app, message)));
  return summarizeBurst(samples);
}
