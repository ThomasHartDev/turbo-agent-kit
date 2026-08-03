import { describe, expect, it, vi } from "vitest";
import { fetchTelemetry, streamAgentTurn } from "./agent-client";
import { canSubmit, chatReducer, initialChatState, isEmpty, type ChatState } from "./chat-state";
import { createSseParser, iterateSseStream } from "./sse";
import { createSubmitGuard } from "./submit-guard";

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

async function collect(
  body: { message: string; conversationId?: string },
  f: typeof fetch,
  signal?: AbortSignal,
) {
  const out = [];
  for await (const e of streamAgentTurn(body, { fetch: f, signal })) out.push(e);
  return out;
}

/** Mirrors console-app: reduce only while the turn is still active. */
function applyIfActive(
  guard: ReturnType<typeof createSubmitGuard>,
  turnId: number,
  state: ChatState,
  action: Parameters<typeof chatReducer>[1],
): ChatState {
  if (!guard.isActive(turnId)) return state;
  return chatReducer(state, action);
}

describe("chatReducer", () => {
  it("starts empty and rejects empty submit", () => {
    expect(isEmpty(initialChatState)).toBe(true);
    expect(canSubmit(initialChatState)).toBe(false);
    expect(chatReducer(initialChatState, { type: "submit" })).toEqual(initialChatState);
  });

  it("streams meta → message → done", () => {
    let s = chatReducer(stateOf({ draft: "  hi  " }), { type: "submit" });
    expect(s).toMatchObject({ draft: "", status: "loading" });
    s = chatReducer(s, { type: "meta", conversationId: "c1" });
    s = chatReducer(s, { type: "message", message: { role: "user", content: "hi" } });
    s = chatReducer(s, { type: "message", message: { role: "assistant", content: "ok" } });
    s = chatReducer(s, { type: "done" });
    expect(s).toMatchObject({ status: "idle", conversationId: "c1" });
    expect(s.messages).toHaveLength(2);
  });

  it("restores draft on fail after submit (HTTP / rate limit)", () => {
    const text = "please book a flight";
    let s = chatReducer(stateOf({ draft: text }), { type: "submit" });
    expect(s.draft).toBe("");
    expect(s.status).toBe("loading");
    s = chatReducer(s, {
      type: "fail",
      error: "Rate limited. Retry after 50ms.",
      restoreDraft: text,
    });
    expect(s).toMatchObject({
      status: "error",
      error: "Rate limited. Retry after 50ms.",
      draft: text,
    });
    expect(canSubmit(s)).toBe(true);
  });

  it("blocks submit while loading or streaming", () => {
    expect(canSubmit(stateOf({ status: "streaming", draft: "z" }))).toBe(false);
    expect(canSubmit(stateOf({ status: "loading", draft: "z" }))).toBe(false);
  });

  it("reset returns initial state", () => {
    expect(
      chatReducer(stateOf({ messages: [{ role: "user", content: "a" }], draft: "x" }), {
        type: "reset",
      }),
    ).toEqual(initialChatState);
  });
});

describe("submitGuard", () => {
  it("allows only one concurrent begin", () => {
    const g = createSubmitGuard();
    const first = g.tryBegin();
    const second = g.tryBegin();
    expect(first).toBe(1);
    expect(second).toBeNull();
    g.end(first!);
    const third = g.tryBegin();
    expect(third).toBe(2);
  });

  it("cancel invalidates in-flight turn so later events do not mutate state", () => {
    const g = createSubmitGuard();
    const turnId = g.tryBegin()!;
    let s = chatReducer(stateOf({ draft: "hi" }), { type: "submit" });
    expect(s.status).toBe("loading");

    g.cancel();
    s = chatReducer(s, { type: "reset" });
    expect(s).toEqual(initialChatState);

    s = applyIfActive(g, turnId, s, { type: "meta", conversationId: "stale" });
    s = applyIfActive(g, turnId, s, {
      type: "message",
      message: { role: "assistant", content: "ghost" },
    });
    s = applyIfActive(g, turnId, s, { type: "done" });
    expect(s).toEqual(initialChatState);
    expect(g.isActive(turnId)).toBe(false);
  });

  it("two rapid tryBegin calls produce one turn id (single request)", () => {
    const g = createSubmitGuard();
    const requests: string[] = [];
    const submit = (msg: string) => {
      const id = g.tryBegin();
      if (id === null) return;
      requests.push(msg);
    };
    submit("first");
    submit("second");
    expect(requests).toEqual(["first"]);
  });
});

describe("sse parser", () => {
  it("buffers partial frames and joins multi-line data", () => {
    const p = createSseParser();
    expect(p.push("event: mes")).toEqual([]);
    expect(p.push("sage\ndata: hello\n\n")).toEqual([{ event: "message", data: "hello" }]);
    expect(p.push("event: message\n: c\ndata: a\ndata: b\n\n")).toEqual([
      { event: "message", data: "a\nb" },
    ]);
    expect(createSseParser().push("data: plain\n\n")).toEqual([
      { event: "message", data: "plain" },
    ]);
  });

  it("iterates a stream that splits mid-frame", async () => {
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
  });
});

describe("streamAgentTurn", () => {
  it("maps a happy-path SSE stream", async () => {
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
  });

  it("maps HTTP failures and empty body", async () => {
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
  });

  it("stops after an SSE error frame (no trailing message)", async () => {
    const mixed = await collect(
      { message: "x" },
      mockFetch(
        new Response(
          sseBody([
            'event: error\ndata: {"error":"turn_failed","detail":"down"}\n\n',
            'event: message\ndata: {"role":"assistant","content":"should-not-appear"}\n\n',
          ]),
          { status: 200 },
        ),
      ),
    );
    expect(mixed).toEqual([{ type: "error", error: "turn_failed", detail: "down" }]);
  });

  it("stops after invalid SSE JSON", async () => {
    const out = await collect(
      { message: "x" },
      mockFetch(
        new Response(sseBody(["event: message\ndata: not-json\n\n", "event: done\ndata: {}\n\n"]), {
          status: 200,
        }),
      ),
    );
    expect(out).toEqual([{ type: "error", error: "invalid_sse_json", detail: "not-json" }]);
  });

  it("passes AbortSignal to fetch and surfaces abort", async () => {
    const ac = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(ac.signal);
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort);
      });
    });
    const pending = collect({ message: "hi" }, fetchMock as unknown as typeof fetch, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("fetchTelemetry", () => {
  it("returns JSON snapshot or throws on error", async () => {
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
