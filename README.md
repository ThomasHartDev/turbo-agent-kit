## Why this exists

Most "AI agent" demos are a single API call in a script. This is the infrastructure around that call: the agent loop, a tool registry, session state, streaming transport, and observability, each behind an interface so the pieces swap without a rewrite.

## Layout

- `packages/agent-core` — the framework-free agent loop, tools, and telemetry
- `apps/server` — a Hono service that streams the agent over SSE
- `apps/console` — a Next.js chat UI

## Stack

Turborepo, pnpm workspaces, TypeScript, Zod, Hono, the Vercel AI SDK, Next.js, and OpenTelemetry.

## Getting started

      pnpm install
      pnpm --filter @agent/core demo

See each package's README for details.
