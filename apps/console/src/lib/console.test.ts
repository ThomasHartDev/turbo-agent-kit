import { describe, expect, it, vi } from "vitest";
import { fetchTelemetry, streamAgentTurn } from "./agent-client";
import { canSubmit, chatReducer, initialChatState, isEmpty, type ChatState } from "./chat-state";
import { createSseParser, iterateSseStream } from "./sse";

const stateOf = (p: Partial<ChatState>): ChatState => ({ ...initialChatState, ...p });
const mockFetch = (res: Response) => vi.fn(async () => res) as unknown as typeof fetch;

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

async function collect(body: { message: string; conversationId?: string }, f: typeof fetch) {
  const out = [];
  for await (const e of streamAgentTurn(body, { fetch: f })) out.push(e);
  return out;
}

describe("chatReducer", () => {
  it("covers empty, stream, fail, concurrent guard, reset", () => {
    expect(isEmpty(initialChatState)).toBe(true);
    expect(canSubmit(initialChatState)).toBe(false);
    expect(chatReducer(initialChatState, { type: "submit" })).toEqual(initialChatState);
    let s = chatReducer(stateOf({ draft: "  hi  " }), { type: "submit" });
    expect(s).toMatchObject({ draft: "", status: "loading" });
    s = chatReducer(s, { type: "meta", conversationId: "c1" });
    s = chatReducer(s, { type: "message", message: { role: "user", content: "hi" } });
    s = chatReducer(s, { type: "message", message: { role: "assistant", content: "ok" } });
    s = chatReducer(s, { type: "done" });
    expect(s).toMatchObject({ status: "idle", conversationId: "c1" });
    expect(s.messages).toHaveLength(2);
    s = chatReducer(stateOf({ draft: "x" }), { type: "submit" });
    s = chatReducer(s, { type: "fail", error: "rate limited" });
    expect(s).toMatchObject({ status: "error", error: "rate limited" });
    expect(canSubmit(stateOf({ status: "streaming", draft: "z" }))).toBe(false);
    expect(
      chatReducer(stateOf({ messages: [{ role: "user", content: "a" }] }), { type: "reset" }),
    ).toEqual(initialChatState);
  });
});

describe("sse + agent client", () => {
  it("buffers partial frames and maps streams plus failures", async () => {
    const p = createSseParser();
    expect(p.push("event: mes")).toEqual([]);
    expect(p.push("sage\ndata: hello\n\n")).toEqual([{ event: "message", data: "hello" }]);
    expect(p.push("event: message\n: c\ndata: a\ndata: b\n\n")).toEqual([
      { event: "message", data: "a\nb" },
    ]);
    expect(createSseParser().push("data: plain\n\n")).toEqual([
      { event: "message", data: "plain" },
    ]);
    const enc = new TextEncoder();
    let i = 0;
    const chunks = ["event: err", 'or\ndata: {"e":1}', "\n\n"];
    const frames = [];
    for await (const f of iterateSseStream(
      new ReadableStream({
        pull(c) {
          if (i >= chunks.length) c.close();
          else c.enqueue(enc.encode(chunks[i++]));
        },
      }),
    )) {
      frames.push(f);
    }
    expect(frames).toEqual([{ event: "error", data: '{"e":1}' }]);

    const fetchMock = vi.fn(
      async () =>
        new Response(
          sseBody([
            'event: meta\ndata: {"conversationId":"c1","channel":"chat"}\n\n',
            'event: message\ndata: {"role":"user","content":"hi"}\n\n',
            'event: done\ndata: {"conversationId":"c1"}\n\n',
          ]),
          { status: 200 },
        ),
    );
    const ok = await collect({ message: "hi" }, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/turn",
      expect.objectContaining({ method: "POST" }),
    );
    expect(ok.map((e) => e.type)).toEqual(["meta", "message", "done"]);
    expect(
      await collect(
        { message: "hi" },
        mockFetch(
          new Response(JSON.stringify({ error: "rate_limited", retryAfterMs: 50 }), {
            status: 429,
          }),
        ),
      ),
    ).toEqual([{ type: "http_error", status: 429, message: "Rate limited. Retry after 50ms." }]);
    expect(
      (await collect({ message: "x" }, mockFetch(new Response(null, { status: 200 }))))[0],
    ).toMatchObject({ type: "http_error", message: "empty response body" });
    const mixed = await collect(
      { message: "x" },
      mockFetch(
        new Response(
          sseBody([
            'event: error\ndata: {"error":"turn_failed","detail":"down"}\n\n',
            "event: message\ndata: not-json\n\n",
          ]),
          { status: 200 },
        ),
      ),
    );
    expect(mixed[0]).toEqual({ type: "error", error: "turn_failed", detail: "down" });
    expect(mixed[1]).toMatchObject({ type: "error", error: "invalid_sse_json" });

    const snap = {
      events: 0,
      all: { count: 0, p50: 0, p95: 0, p99: 0 },
      llm: { count: 0, p50: 0, p95: 0, p99: 0 },
      tool: { count: 0, p50: 0, p95: 0, p99: 0 },
    };
    await expect(
      fetchTelemetry({ fetch: mockFetch(new Response(JSON.stringify(snap), { status: 200 })) }),
    ).resolves.toEqual(snap);
    await expect(
      fetchTelemetry({
        fetch: mockFetch(new Response(JSON.stringify({ error: "nope" }), { status: 500 })),
      }),
    ).rejects.toThrow("nope");
  });
});
