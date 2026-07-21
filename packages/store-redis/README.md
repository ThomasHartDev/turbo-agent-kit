# @agent/store-redis

Redis-backed persistence for the agent: a conversation store and a distributed rate limiter, both behind a narrow `RedisPort` so the same code runs against a real server or an in-process fallback. No running Redis is needed for CI or local tests.

## The port

Every consumer talks to `RedisPort`, the small slice of commands this package uses (`get`, `set`, `del`, `rpush`, `lrange`, `expire`, `eval`). A real client plugs in through a thin adapter; `InMemoryRedis` implements the same port with lazy TTL eviction against an injectable clock. That single seam is what makes the fallback and the tests possible without touching the store or limiter code.

## ConversationStore

`RedisConversationStore` keeps conversation metadata in a string key and the message history in a Redis list. Appending is one atomic `RPUSH`, so concurrent writers on different nodes never lose an update the way a read-modify-write of a serialized blob would. Reads validate every message with Zod on the way out, because bytes coming back from an external store are untrusted. An optional TTL slides forward on each append, so idle conversations expire on their own.

```ts
import { createConversationStore } from "@agent/store-redis";

const store = createConversationStore({ ttlSeconds: 3600 }); // in-memory with no client
const convo = await store.create("chat");
await store.append(convo.id, { role: "user", content: "book an appointment" });
const loaded = await store.get(convo.id);
```

Pass a real client to go distributed:

```ts
import Redis from "ioredis";
const client = new Redis(process.env.REDIS_URL);
const store = createConversationStore({ redis: adapt(client), ttlSeconds: 3600 });
```

## RateLimiter

`RedisRateLimiter` is a fixed-window counter shared across every node pointing at the same Redis. The increment and the expiry run in one Lua script, so a counter can never be created without a TTL, even if a process dies mid-call. It returns the same `{ ok, remaining, retryAfterMs }` result as the in-process limiters in `@agent/rate-limiter`, so callers swap between them freely.

```ts
import { createRateLimiter } from "@agent/store-redis";

const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const r = await limiter.tryAcquire(`tenant:${tenantId}`);
if (!r.ok) throw new Error(`rate limited, retry in ${r.retryAfterMs}ms`);
```

Fixed-window trades exactness for memory: one integer per window instead of a timestamp per request, at the cost of up to 2x the limit across a boundary. When exactness matters, use `SlidingWindowLog` from `@agent/rate-limiter` instead.

## Tests

```
pnpm --filter @agent/store-redis test
```
