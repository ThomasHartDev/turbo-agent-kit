# turbo-agent-kit

A Turbo + pnpm monorepo for building LLM agents: agent loop, pluggable providers, rate limiting, Redis-backed session state, and an HTTP server that streams turns over SSE with latency telemetry and structured logs.

## What this demonstrates

Most "AI agent" demos are a single API call in a script. This is the infrastructure around that call: the agent loop, a tool registry, session state, streaming transport, and observability, each behind an interface so the pieces swap without a rewrite.

## Layout

- `packages/agent-core` — the framework-free agent loop, tools, and telemetry
- `packages/llm` — the real LLM adapter over the Vercel AI SDK, key-gated with a mock fallback
- `packages/config` — Zod-validated env loading shared across the workspace
- `packages/rate-limiter` — token bucket, sliding-window log, and a concurrency semaphore for capping calls to a model provider
- `packages/store-redis` — Redis-backed conversation store and distributed rate limiter behind one port, with an in-memory fallback
- `apps/server` — a Hono service that streams the agent over SSE and exposes latency percentiles
- `apps/console` — a Next.js chat UI (planned)

## Providers

The agent loop talks to a small `LLMProvider` interface: given the message history and the tool specs, return either a final answer or a single tool call. `MockLLMProvider` in `agent-core` is the deterministic test double.

`packages/llm` adds a real adapter on the Vercel AI SDK. `createLLMProvider` reads `OPENAI_API_KEY` (or an explicit config key) and returns the AI SDK adapter when a key is present, otherwise it falls back to the mock. So the same code runs in CI and local dev with no credentials, and against a real model once a key is set.

```ts
import { createLLMProvider } from "@agent/llm";
import { runAgentTurn } from "@agent/core";

const llm = createLLMProvider(); // mock with no key, real model with OPENAI_API_KEY
await runAgentTurn(conversation, "book an appointment", llm, telemetry);
```

## HTTP server

`createApp` injects LLM, store, rate limiter, telemetry, and logger so tests use `app.request` with no live port. Entry wires `createLLMProvider` (mock without a key) and a JSON logger.

```bash
pnpm --filter @agent/server dev
# GET  /healthz
# GET  /telemetry
# POST /agent/turn  { "message": "...", "conversationId?": "..." }
```

A turn streams `meta` → `message*` → `done` as `text/event-stream`. Empty input is 400, unknown conversation ids are 404, and an empty token bucket is 429 with `Retry-After`. `/healthz` and `/telemetry` are not rate limited so probes and dashboards never steal client tokens.

### Latency telemetry

`GET /telemetry` returns nearest-rank p50/p95/p99 for LLM and tool spans recorded during turns:

```json
{
  "events": 12,
  "all": { "count": 12, "p50": 18, "p95": 90, "p99": 110 },
  "llm": { "count": 10, "p50": 20, "p95": 95, "p99": 110 },
  "tool": { "count": 2, "p50": 5, "p95": 12, "p99": 12 }
}
```

Empty series return zeros so scrapers can poll before traffic arrives.

### Structured logging

Every request emits one JSON line to stdout (`ts`, `level`, `service`, `msg`, `requestId`, `method`, `path`, `status`, `durationMs`). Set `LOG_LEVEL=debug|info|warn|error` (default `info`). Clients may pass `X-Request-Id`; the server echoes it (or mints a UUID) so logs join with upstream traces.

## Stack

Turborepo, pnpm workspaces, TypeScript, Zod, Hono, the Vercel AI SDK, Next.js, and OpenTelemetry.

## Concepts demonstrated

- Schema-driven validation at the process boundary, coercing untyped env strings into typed config
- Fail-fast configuration with aggregated errors: report every invalid or missing variable at once, not the first
- Secret redaction so credentials never reach logs or error messages
- Immutable config via `Object.freeze`
- Provider abstraction behind a narrow interface with a deterministic mock for tests
- Structured telemetry around the agent loop
- Nearest-rank percentile latency aggregation (p50/p95/p99) over in-process timing samples
- Structured JSON logging (one object per line) for container log collectors
- Request correlation IDs propagated via `X-Request-Id` and joined into log fields
- Token-bucket rate limiting: continuous refill with a burst ceiling, and a monotonic-clock guard against backward time
- Exact sliding-window log limiting, which avoids the 2x-at-the-boundary overshoot of a fixed-window counter
- Concurrency control with a FIFO counting semaphore and direct permit handoff on release
- Deterministic time in tests via an injectable clock instead of real timers
- Port abstraction over a Redis client (a narrow command interface) so the store and limiter are testable and swappable without a running server
- Atomic list appends for conversation history, avoiding the lost-update race of read-modify-write on a serialized blob
- Atomic check-and-increment via a Lua script, so a rate-limit counter can never exist without its expiry
- Distributed fixed-window rate limiting shared across nodes, with the memory-versus-exactness tradeoff against a sliding-window log
- Boundary validation with Zod on data read back from an external store
- Sliding TTL for idle-session expiry
- Server-Sent Events (SSE) streaming of multi-step agent turns over HTTP
- Dependency-injected app factory for testing HTTP handlers without a live port
- Rate-limit middleware that fails closed and leaves health probes unmetered
- Backpressure-safe SSE writes via a promise chain from a synchronous turn hook

## What's implemented

- `packages/agent-core`: framework-free agent loop, tool registry, session store, telemetry, and a mock provider
- `packages/llm`: key-gated Vercel AI SDK provider with a mock fallback
- `packages/config`: Zod-validated env/config loader shared across the workspace
- `packages/rate-limiter`: token-bucket + sliding-window limiter and a concurrency semaphore, with refill, burst, and concurrency covered by tests
- `packages/store-redis`: Redis-backed conversation store (atomic list appends, Zod-validated reads, sliding TTL) and a distributed fixed-window rate limiter behind a `RedisPort`, with an in-memory fallback used in tests
- `apps/server` (Hono): `POST /agent/turn` SSE streaming, `GET /healthz`, rate-limit middleware returning 429
- `apps/server`: `GET /telemetry` (p50/p95/p99) and structured JSON logging

## Getting started

```bash
pnpm install
pnpm --filter @agent/core demo
pnpm --filter @agent/server dev
```

Run the tests with `pnpm install && pnpm test`. Typecheck with `pnpm typecheck`.

See each package's README for details.
