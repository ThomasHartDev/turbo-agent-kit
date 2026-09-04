# Why a monorepo

This is one product. The agent loop, the LLM adapter, the Redis store, the Hono server, and the console share TypeScript types (`LLMProvider`, tools, messages). A loop change and the SSE handler have to land together. A polyrepo would version those contracts across publishes and wait on registry lag.

pnpm `workspace:*` is the edge list. Turbo `^build` walks that directed acyclic graph and caches each package from its inputs, so a store-only change does not rebuild the console. One lockfile and one CI workflow cover the graph.

The cost is a coupled release: you cannot ship `@agent/core` on a cadence the server ignores. That is fine here. The packages are layers of one kit, not a public SDK. Split later if a package grows a second consumer with its own release clock.
