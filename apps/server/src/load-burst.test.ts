import { describe, expect, it } from "vitest";
import {
  Telemetry,
  type LLMProvider,
  type LLMResult,
  type Message,
  type ToolSpec,
} from "@agent/core";
import { TokenBucket } from "@agent/rate-limiter";
import { createApp } from "./create-app";
import { createLogger } from "./logger";
import {
  fireTurnBurst,
  latencySummary,
  parseSseFrames,
  summarizeBurst,
  type LoadSample,
} from "./load-burst";

class FixedLLM implements LLMProvider {
  name = "fixed";
  constructor(private readonly reply: LLMResult) {}
  async complete(_messages: Message[], _tools: ToolSpec[]): Promise<LLMResult> {
    return this.reply;
  }
}

class QueuedDelayLLM implements LLMProvider {
  name = "queued-delay";
  private i = 0;
  constructor(private readonly delaysMs: number[]) {}
  async complete(_messages: Message[], _tools: ToolSpec[]): Promise<LLMResult> {
    const ms = this.delaysMs[this.i] ?? 0;
    this.i += 1;
    if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
    return { kind: "final", content: "ok" };
  }
}

function silentLogger() {
  return createLogger({ write: () => {}, level: "error" });
}

function sample(status: number, durationMs: number): LoadSample {
  return {
    status,
    durationMs,
    contentType: status === 200 ? "text/event-stream" : "application/json",
    retryAfter: status === 429 ? "1" : null,
    remaining: null,
    events: [],
  };
}

describe("parseSseFrames", () => {
  it("returns nothing for empty or comment-only input", () => {
    expect(parseSseFrames("")).toEqual([]);
    expect(parseSseFrames(": keep-alive\n\n")).toEqual([]);
  });

  it("parses CRLF frames and joins multi-line data", () => {
    const body = 'event: meta\r\ndata: {"id":1}\r\n\r\nevent: done\r\ndata: a\r\ndata: b\r\n\r\n';
    expect(parseSseFrames(body)).toEqual([
      { event: "meta", data: '{"id":1}' },
      { event: "done", data: "a\nb" },
    ]);
  });
});

describe("latencySummary / summarizeBurst", () => {
  it("is empty-safe", () => {
    expect(latencySummary([])).toEqual({ count: 0, p50: 0, p95: 0, p99: 0 });
    expect(summarizeBurst([])).toMatchObject({
      admitted: 0,
      rejected: 0,
      other: 0,
      latency: {
        all: { count: 0, p50: 0, p95: 0, p99: 0 },
        admitted: { count: 0, p50: 0, p95: 0, p99: 0 },
        rejected: { count: 0, p50: 0, p95: 0, p99: 0 },
      },
    });
  });

  it("uses nearest-rank p50/p95/p99 and splits 200 vs 429", () => {
    const samples = Array.from({ length: 100 }, (_, i) => sample(i < 80 ? 200 : 429, i + 1));
    const burst = summarizeBurst(samples);
    expect(burst.admitted).toBe(80);
    expect(burst.rejected).toBe(20);
    expect(burst.other).toBe(0);
    expect(burst.latency.all).toEqual({ count: 100, p50: 50, p95: 95, p99: 99 });
    expect(burst.latency.admitted).toEqual({ count: 80, p50: 40, p95: 76, p99: 80 });
    expect(burst.latency.rejected).toEqual({ count: 20, p50: 90, p95: 99, p99: 100 });
  });

  it("counts non-200/429 as other", () => {
    const burst = summarizeBurst([sample(200, 10), sample(429, 2), sample(500, 3), sample(400, 4)]);
    expect(burst).toMatchObject({ admitted: 1, rejected: 1, other: 2 });
  });
});

describe("fireTurnBurst", () => {
  it("rejects a non-integer n", async () => {
    const app = createApp({
      llm: new FixedLLM({ kind: "final", content: "ok" }),
      logger: silentLogger(),
    });
    await expect(fireTurnBurst(app, { n: -1 })).rejects.toThrow(RangeError);
    await expect(fireTurnBurst(app, { n: 1.5 })).rejects.toThrow(RangeError);
  });

  it("joins an empty burst without hitting the server", async () => {
    const telemetry = new Telemetry();
    const app = createApp({
      llm: new FixedLLM({ kind: "final", content: "ok" }),
      limiter: new TokenBucket({ capacity: 1, refillPerSecond: 0.001 }),
      telemetry,
      logger: silentLogger(),
    });
    const burst = await fireTurnBurst(app, { n: 0 });
    expect(burst.samples).toEqual([]);
    expect(burst.admitted).toBe(0);
    expect(telemetry.all()).toHaveLength(0);
  });

  it("admits a burst equal to capacity with a full SSE stream", async () => {
    const telemetry = new Telemetry();
    const app = createApp({
      llm: new FixedLLM({ kind: "final", content: "ok" }),
      limiter: new TokenBucket({ capacity: 4, refillPerSecond: 0.001 }),
      telemetry,
      logger: silentLogger(),
    });
    const burst = await fireTurnBurst(app, { n: 4, message: (i) => `m-${i}` });
    expect(burst.admitted).toBe(4);
    expect(burst.rejected).toBe(0);
    expect(burst.other).toBe(0);
    for (const s of burst.samples) {
      expect(s.status).toBe(200);
      expect(s.contentType).toMatch(/text\/event-stream/);
      expect(s.events.map((e) => e.event)).toEqual(["meta", "message", "message", "done"]);
      const user = JSON.parse(s.events[1]!.data) as Message;
      expect(user).toMatchObject({ role: "user" });
      expect(user.content).toMatch(/^m-\d$/);
    }
    expect(telemetry.all()).toHaveLength(4);
  });

  it("admits exactly capacity under a concurrent burst and 429s the rest", async () => {
    const telemetry = new Telemetry();
    const app = createApp({
      llm: new QueuedDelayLLM([25, 25, 25]),
      limiter: new TokenBucket({ capacity: 3, refillPerSecond: 0.001 }),
      telemetry,
      logger: silentLogger(),
    });

    const burst = await fireTurnBurst(app, { n: 12 });
    expect(burst.samples).toHaveLength(12);
    expect(burst.admitted).toBe(3);
    expect(burst.rejected).toBe(9);
    expect(burst.other).toBe(0);

    const admitted = burst.samples.filter((s) => s.status === 200);
    const rejected = burst.samples.filter((s) => s.status === 429);
    expect(admitted).toHaveLength(3);
    expect(rejected).toHaveLength(9);

    for (const s of admitted) {
      expect(s.contentType).toMatch(/text\/event-stream/);
      expect(s.events.map((e) => e.event)).toEqual(["meta", "message", "message", "done"]);
    }
    for (const s of rejected) {
      expect(s.contentType).toMatch(/application\/json/);
      expect(s.events).toEqual([]);
      expect(s.retryAfter).toBeTruthy();
      expect(s.remaining).toBe("0");
    }

    expect(burst.latency.admitted.p50).toBeGreaterThanOrEqual(20);
    expect(burst.latency.admitted.p95).toBeGreaterThanOrEqual(burst.latency.admitted.p50);
    expect(burst.latency.admitted.p99).toBeGreaterThanOrEqual(burst.latency.admitted.p95);
    expect(burst.latency.rejected.count).toBe(9);
  });

  it("records LLM percentiles only for admitted turns", async () => {
    const delays = [20, 40, 60, 80, 100];
    const telemetry = new Telemetry();
    const limiter = new TokenBucket({ capacity: 5, refillPerSecond: 0.001 });
    const app = createApp({
      llm: new QueuedDelayLLM(delays),
      limiter,
      telemetry,
      logger: silentLogger(),
    });

    const burst = await fireTurnBurst(app, { n: 11 });
    expect(burst.admitted).toBe(5);
    expect(burst.rejected).toBe(6);

    const body = (await (await app.request("/telemetry")).json()) as {
      events: number;
      llm: { count: number; p50: number; p95: number; p99: number };
      tool: { count: number };
    };
    expect(body.events).toBe(5);
    expect(body.llm.count).toBe(5);
    expect(body.tool.count).toBe(0);
    expect(body.llm.p50).toBeGreaterThanOrEqual(40);
    expect(body.llm.p95).toBeGreaterThanOrEqual(body.llm.p50);
    expect(body.llm.p99).toBeGreaterThanOrEqual(body.llm.p95);

    const recorded = telemetry
      .all()
      .map((e) => e.ms)
      .sort((a, b) => a - b);
    expect(recorded).toHaveLength(5);
    expect(recorded[0]!).toBeGreaterThanOrEqual(15);
    expect(recorded[4]!).toBeGreaterThanOrEqual(70);

    expect((await app.request("/telemetry")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
    const stillLimited = await fireTurnBurst(app, { n: 4 });
    expect(stillLimited.rejected).toBe(4);
    expect(telemetry.all()).toHaveLength(5);
  });

  it("counts limiter throws as other, not 429", async () => {
    const limiter = {
      tryAcquire(): never {
        throw new Error("limiter down");
      },
    };
    const app = createApp({
      llm: new FixedLLM({ kind: "final", content: "ok" }),
      limiter,
      logger: silentLogger(),
    });
    const burst = await fireTurnBurst(app, { n: 3 });
    expect(burst.admitted).toBe(0);
    expect(burst.rejected).toBe(0);
    expect(burst.other).toBe(3);
    expect(burst.samples.every((s) => s.status === 500)).toBe(true);
  });
});
