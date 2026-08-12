import { describe, expect, it } from "vitest";
import {
  InMemoryConversationStore,
  Telemetry,
  type LLMProvider,
  type LLMResult,
  type Message,
  type ToolSpec,
} from "@agent/core";
import { TokenBucket } from "@agent/rate-limiter";
import { createApp } from "./create-app";
import { createLogger } from "./logger";

class FixedLLM implements LLMProvider {
  name = "fixed";
  constructor(private readonly reply: LLMResult | ((messages: Message[]) => LLMResult)) {}
  async complete(messages: Message[], _tools: ToolSpec[]): Promise<LLMResult> {
    return typeof this.reply === "function" ? this.reply(messages) : this.reply;
  }
}

function silentLogger() {
  return createLogger({ write: () => {}, level: "error" });
}

function parseSSE(body: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  for (const block of body.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    let event = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data !== "" || event !== "message") events.push({ event, data });
  }
  return events;
}

function appWith(limiter?: TokenBucket, extras: { telemetry?: Telemetry } = {}) {
  return createApp({
    llm: new FixedLLM({ kind: "final", content: "ok" }),
    limiter: limiter ?? new TokenBucket({ capacity: 20, refillPerSecond: 20 }),
    logger: silentLogger(),
    telemetry: extras.telemetry,
  });
}

async function postTurn(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/agent/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("apps/server", () => {
  it("GET /healthz is free of the rate limiter", async () => {
    const limiter = new TokenBucket({ capacity: 1, refillPerSecond: 0.001, initialTokens: 0 });
    const app = appWith(limiter);
    expect((await app.request("/healthz")).status).toBe(200);
    expect(await (await app.request("/healthz")).json()).toEqual({ status: "ok" });
    expect((await postTurn(app, { message: "hello" })).status).toBe(429);
  });

  it("streams meta, user/assistant messages, and done over SSE", async () => {
    const res = await postTurn(appWith(), { message: "hi there" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = parseSSE(await res.text());
    expect(events.map((e) => e.event)).toEqual(["meta", "message", "message", "done"]);
    const meta = JSON.parse(events[0]!.data) as { conversationId: string; channel: string };
    expect(meta.channel).toBe("chat");
    const msgs = events
      .filter((e) => e.event === "message")
      .map((e) => JSON.parse(e.data) as Message);
    expect(msgs[0]).toMatchObject({ role: "user", content: "hi there" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "ok" });
    expect(JSON.parse(events[3]!.data)).toEqual({ conversationId: meta.conversationId });
  });

  it("reuses conversation history and 404s unknown ids", async () => {
    const store = new InMemoryConversationStore();
    const existing = store.create("sms");
    existing.messages.push({ role: "user", content: "earlier" });
    const app = createApp({
      store,
      llm: new FixedLLM({ kind: "final", content: "second" }),
      limiter: new TokenBucket({ capacity: 10, refillPerSecond: 10 }),
      logger: silentLogger(),
    });

    const res = await postTurn(app, { message: "again", conversationId: existing.id });
    expect(res.status).toBe(200);
    const meta = JSON.parse(parseSSE(await res.text())[0]!.data) as {
      conversationId: string;
      channel: string;
    };
    expect(meta).toEqual({ conversationId: existing.id, channel: "sms" });
    expect(store.get(existing.id)!.messages.map((m) => m.content)).toEqual([
      "earlier",
      "again",
      "second",
    ]);

    const missing = await postTurn(app, { message: "x", conversationId: "nope" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "conversation_not_found" });
  });

  it("rejects empty messages and invalid json with 400", async () => {
    const app = appWith();
    const empty = await postTurn(app, { message: "   " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "validation_error" });
    const bad = await postTurn(app, "{not-json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_json" });
  });

  it("returns 429 with Retry-After after the burst is spent", async () => {
    const limiter = new TokenBucket({ capacity: 2, refillPerSecond: 0.001 });
    const app = appWith(limiter);
    expect((await postTurn(app, { message: "a" })).status).toBe(200);
    expect((await postTurn(app, { message: "b" })).status).toBe(200);
    const denied = await postTurn(app, { message: "c" });
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBeTruthy();
    expect(denied.headers.get("X-RateLimit-Remaining")).toBe("0");
    const body = (await denied.json()) as { error: string; retryAfterMs: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("emits an error SSE event when the LLM throws", async () => {
    const llm: LLMProvider = {
      name: "boom",
      complete: async () => {
        throw new Error("provider down");
      },
    };
    const lines: string[] = [];
    const app = createApp({
      llm,
      limiter: new TokenBucket({ capacity: 5, refillPerSecond: 5 }),
      logger: createLogger({ write: (line) => lines.push(line), level: "info" }),
    });
    const res = await postTurn(app, { message: "hello" });
    expect(res.status).toBe(200);
    const err = parseSSE(await res.text()).find((e) => e.event === "error");
    expect(err).toBeDefined();
    expect(JSON.parse(err!.data)).toMatchObject({
      error: "turn_failed",
      detail: "provider down",
    });
    const turnFailed = lines
      .map((l) => JSON.parse(l.trim()) as { msg: string; detail?: string })
      .find((e) => e.msg === "turn_failed");
    expect(turnFailed).toMatchObject({ detail: "provider down" });
  });

  it("GET /telemetry returns empty summaries before any turns", async () => {
    const app = appWith();
    const res = await app.request("/telemetry");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: 0,
      all: { count: 0, p50: 0, p95: 0, p99: 0 },
      llm: { count: 0, p50: 0, p95: 0, p99: 0 },
      tool: { count: 0, p50: 0, p95: 0, p99: 0 },
    });
  });

  it("GET /telemetry reflects p50/p95/p99 after turns and stays unmetered", async () => {
    const telemetry = new Telemetry();
    const limiter = new TokenBucket({ capacity: 1, refillPerSecond: 0.001, initialTokens: 0 });
    const app = createApp({
      llm: new FixedLLM({ kind: "final", content: "ok" }),
      limiter,
      telemetry,
      logger: silentLogger(),
    });

    expect((await app.request("/telemetry")).status).toBe(200);
    expect((await postTurn(app, { message: "hello" })).status).toBe(429);

    for (let ms = 1; ms <= 100; ms++) {
      telemetry.record({ type: "llm", channel: "chat", ms, detail: "final" });
    }
    telemetry.record({ type: "tool", channel: "chat", ms: 5, detail: "checkAvailability" });

    const body = (await (await app.request("/telemetry")).json()) as {
      events: number;
      llm: { count: number; p50: number; p95: number; p99: number };
      tool: { count: number; p50: number; p95: number; p99: number };
      all: { count: number };
    };
    expect(body.events).toBe(101);
    expect(body.llm).toEqual({ count: 100, p50: 50, p95: 95, p99: 99 });
    expect(body.tool).toEqual({ count: 1, p50: 5, p95: 5, p99: 5 });
    expect(body.all.count).toBe(101);
  });

  it("echoes X-Request-Id and emits structured request logs", async () => {
    const lines: string[] = [];
    const app = createApp({
      llm: new FixedLLM({ kind: "final", content: "ok" }),
      limiter: new TokenBucket({ capacity: 10, refillPerSecond: 10 }),
      logger: createLogger({ write: (line) => lines.push(line), level: "info" }),
    });

    const res = await app.request("/healthz", { headers: { "x-request-id": "req-abc" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("req-abc");

    const entry = JSON.parse(lines[0]!.trim()) as {
      msg: string;
      requestId: string;
      method: string;
      path: string;
      status: number;
      durationMs: number;
      level: string;
    };
    expect(entry).toMatchObject({
      msg: "request",
      requestId: "req-abc",
      method: "GET",
      path: "/healthz",
      status: 200,
      level: "info",
    });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);

    lines.length = 0;
    await postTurn(app, { message: "   " });
    const warn = JSON.parse(lines[0]!.trim()) as { level: string; status: number };
    expect(warn.level).toBe("warn");
    expect(warn.status).toBe(400);
  });
});
