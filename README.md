## Why this exists

Most "AI agent" demos are a single API call in a script. This is the infrastructure around that call: the agent loop, a tool registry, session state, streaming transport, and observability, each behind an interface so the pieces swap without a rewrite.

## Layout

- `packages/agent-core` — the framework-free agent loop, tools, and telemetry
- `packages/llm` — the real LLM adapter over the Vercel AI SDK, key-gated with a mock fallback
- `packages/config` — Zod-validated env loading shared across the workspace
- `packages/rate-limiter` — token bucket, sliding-window log, and a concurrency semaphore for capping calls to a model provider
- `apps/server` — a Hono service that streams the agent over SSE
- `apps/console` — a Next.js chat UI

## Providers

The agent loop talks to a small `LLMProvider` interface: given the message history and the tool specs, return either a final answer or a single tool call. `MockLLMProvider` in `agent-core` is the deterministic test double.

`packages/llm` adds a real adapter on the Vercel AI SDK. `createLLMProvider` reads `OPENAI_API_KEY` (or an explicit config key) and returns the AI SDK adapter when a key is present, otherwise it falls back to the mock. So the same code runs in CI and local dev with no credentials, and against a real model once a key is set.

```ts
import { createLLMProvider } from "@agent/llm";
import { runAgentTurn } from "@agent/core";

const llm = createLLMProvider(); // mock with no key, real model with OPENAI_API_KEY
await runAgentTurn(conversation, "book an appointment", llm, telemetry);
```

## Stack

Turborepo, pnpm workspaces, TypeScript, Zod, Hono, the Vercel AI SDK, Next.js, and OpenTelemetry.

## Concepts demonstrated

- Schema-driven validation at the process boundary, coercing untyped env strings into typed config
- Fail-fast configuration with aggregated errors: report every invalid or missing variable at once, not the first
- Secret redaction so credentials never reach logs or error messages
- Immutable config via `Object.freeze`
- Provider abstraction behind a narrow interface with a deterministic mock for tests
- Structured telemetry around the agent loop
- Token-bucket rate limiting: continuous refill with a burst ceiling, and a monotonic-clock guard against backward time
- Exact sliding-window log limiting, which avoids the 2x-at-the-boundary overshoot of a fixed-window counter
- Concurrency control with a FIFO counting semaphore and direct permit handoff on release
- Deterministic time in tests via an injectable clock instead of real timers

## What's implemented

- `packages/agent-core`: framework-free agent loop, tool registry, session store, telemetry, and a mock provider
- `packages/llm`: key-gated Vercel AI SDK provider with a mock fallback
- `packages/config`: Zod-validated env/config loader shared across the workspace
- `packages/rate-limiter`: token-bucket + sliding-window limiter and a concurrency semaphore, with refill, burst, and concurrency covered by tests

## Getting started

      pnpm install
      pnpm --filter @agent/core demo

Run the tests with `pnpm install && pnpm test`.

See each package's README for details.
