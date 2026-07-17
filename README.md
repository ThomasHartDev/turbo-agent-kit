## Why this exists

Most "AI agent" demos are a single API call in a script. This is the infrastructure around that call: the agent loop, a tool registry, session state, streaming transport, and observability, each behind an interface so the pieces swap without a rewrite.

## Layout

- `packages/agent-core` — the framework-free agent loop, tools, and telemetry
- `packages/llm` — the real LLM adapter over the Vercel AI SDK, key-gated with a mock fallback
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

## Getting started

      pnpm install
      pnpm --filter @agent/core demo

Run the tests with `pnpm install && pnpm test`.

See each package's README for details.
