import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  InMemoryConversationStore,
  MockLLMProvider,
  Telemetry,
  runAgentTurn,
  type ConversationStore,
  type LLMProvider,
  type Message,
} from "@agent/core";
import { TokenBucket, type RateLimiter } from "@agent/rate-limiter";
import { rateLimitMiddleware } from "./rate-limit";

const TurnBody = z.object({
  message: z.string().trim().min(1, "message must not be empty"),
  conversationId: z.string().min(1).optional(),
  channel: z.enum(["chat", "sms", "voice"]).default("chat"),
});

export interface AppDeps {
  llm?: LLMProvider;
  store?: ConversationStore;
  limiter?: RateLimiter;
  telemetry?: Telemetry;
}

export function createApp(deps: AppDeps = {}) {
  const llm = deps.llm ?? new MockLLMProvider();
  const store = deps.store ?? new InMemoryConversationStore();
  const limiter = deps.limiter ?? new TokenBucket({ capacity: 30, refillPerSecond: 5 });
  const telemetry = deps.telemetry ?? new Telemetry();

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Rate limit only the turn endpoint. Health checks must stay free so k8s
  // probes never compete with client traffic for tokens.
  app.post("/agent/turn", rateLimitMiddleware(limiter), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const parsed = TurnBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "validation_error",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join(".") || "(root)",
            message: i.message,
          })),
        },
        400,
      );
    }

    const { message, conversationId, channel } = parsed.data;
    let conversation = conversationId ? store.get(conversationId) : undefined;
    if (conversationId && !conversation) {
      return c.json({ error: "conversation_not_found", conversationId }, 404);
    }
    if (!conversation) {
      conversation = store.create(channel);
    }

    // Capture the conversation object so the stream closure always mutates the
    // same store entry (create already registered it by id).
    const convo = conversation;

    return streamSSE(c, async (stream) => {
      c.header("X-Conversation-Id", convo.id);
      await stream.writeSSE({
        event: "meta",
        data: JSON.stringify({ conversationId: convo.id, channel: convo.channel }),
      });

      // TurnHooks.onMessage is sync, but writeSSE is async. Chain the writes so
      // frames stay ordered and the stream flushes before we emit `done`.
      let writes: Promise<void> = Promise.resolve();
      const enqueue = (event: string, data: unknown) => {
        writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
      };

      try {
        await runAgentTurn(convo, message, llm, telemetry, {
          onMessage: (m: Message) => enqueue("message", m),
        });
        await writes;
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ conversationId: convo.id }),
        });
      } catch (err) {
        await writes;
        const detail = err instanceof Error ? err.message : "unknown error";
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "turn_failed", detail }),
        });
      }
    });
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
