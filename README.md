# turbo-agent-kit

A Turbo + pnpm monorepo for building LLM agents: agent loop, pluggable providers, rate limiting, Redis-backed session state, and an HTTP server that streams turns over SSE with latency telemetry, structured logs, and a multi-stage production image.

## What this demonstrates

Most "AI agent" demos are a single API call in a script. This is the infrastructure around that call: the agent loop, a tool registry, session state, streaming transport, and observability, each behind an interface so the pieces swap without a rewrite.

## Layout

- `packages/agent-core` — the framework-free agent loop, tools, telemetry, and an executable sequence diagram of the turn protocol
- `packages/llm` — the real LLM adapter over the Vercel AI SDK, key-gated with a mock fallback
- `packages/config` — Zod-validated env loading shared across the workspace
- `packages/rate-limiter` — token bucket, sliding-window log, and a concurrency semaphore for capping calls to a model provider
- `packages/store-redis` — Redis-backed conversation store and distributed rate limiter behind one port, with an in-memory fallback
- `packages/retrieval` — recursive chunking, hashing embedder, and in-memory cosine search
- `packages/telemetry` — OpenTelemetry spans around HTTP turns, LLM calls, and tools
- `apps/server` — a Hono service that streams the agent over SSE and exposes latency percentiles
- `apps/server/Dockerfile` — multi-stage image (deps, build, runtime), non-root `agent` uid, `HEALTHCHECK` on `/healthz`
- `apps/console` — a Next.js chat UI over the SSE turn stream

Each `packages/*` workspace has its own README. The agent-loop sequence diagram is generated from a typed AST in `@agent/core` and locked to `packages/agent-core/README.md`.

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

### Container image

Four stages: `deps` copies lockfile and `package.json` only, `build` compiles and `pnpm deploy --prod`s a standalone tree, `runtime` copies that tree, drops to uid 999 (`agent`, no login shell), and probes `GET /healthz` on `127.0.0.1` with Node's `fetch`.

```bash
docker build -f apps/server/Dockerfile -t agent-server:local .
kind load docker-image agent-server:local
minikube image load agent-server:local
docker run --rm -p 8787:8787 agent-server:local
# GET http://127.0.0.1:8787/healthz
# Kubernetes pulls this tag with imagePullPolicy: Never after kind/minikube load.
```

`.dockerignore` keeps `.git`, `node_modules`, `dist`, and `.env*` out of the daemon. `apps/server/src/image-policy.ts` parses the recipe and fails tests if the final stage is root, has `HEALTHCHECK NONE`, uses `ADD`, or bakes a secret into `ENV`/`ARG`.

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
- Multi-stage image builds: the compile toolchain and `devDependencies` never land in the runtime filesystem
- Least-privilege containers: dedicated non-root uid, no login shell, `nologin` home
- Liveness `HEALTHCHECK` against `/healthz` on loopback, separate from the client rate-limit budget
- Build-context minimization via `.dockerignore` so git metadata, env files, and `node_modules` never reach the daemon
- Static image policy: parse Dockerfile instructions and fail closed on root, disabled probes, `ADD`, and secret `ENV`/`ARG`
- Sequence diagrams as an executable protocol spec: typed participants, `loop`/`alt` fragments, Mermaid rendering, activation-stack well-formedness
- Regular language for a single agent turn: `user (llm tool_call tool_result)* llm final` or budget exhaustion
- Documentation-as-code: the README mermaid fence is asserted equal to `toMermaid(AGENT_LOOP_DIAGRAM)`

- Kubernetes namespace isolation and label selector contracts: Service and Deployment `matchLabels` must be a subset of the pod template labels
- ConfigMap versus Secret: non-confidential config as strings, credentials via `secretKeyRef`
- StatefulSet stable identity: ordinal DNS, headless Service (`clusterIP: None`), `volumeClaimTemplates`
- Liveness versus readiness probes
- Pod security: non-root uid via `runAsNonRoot` / `runAsUser`
- `fsGroup` on a StatefulSet so a non-root uid can write AOF on a default RWO PVC
- Local cluster images: pinned tag plus `imagePullPolicy: Never` after `kind load` / `minikube image load`

- Dockerfile/workspace copy reconciliation: every `workspace:*` dependency of the server must appear in a `COPY` or the image is incomplete
- Shift-left CI: lint, compile the container image, then `helm lint` + `helm template` as a cluster-free dry-run
- Kubernetes deploy invariants on rendered YAML: DNS-1123 names, label/selector subset, pinned image tags, `/healthz` probes

- Kubernetes Ingress: host/path routing with a named-port backend bound to a ClusterIP Service
- Horizontal Pod Autoscaler: CPU utilization scaling, which requires a cpu request as the utilization denominator
- Kubelet liveness vs readiness on `GET /healthz`, with detection window `failureThreshold * periodSeconds` (readiness faster than liveness) and `terminationGracePeriodSeconds` covering drain

- Open-loop concurrent burst generation against an HTTP handler: all arrivals in flight, then join
- Token-bucket burst ceiling under concurrent arrivals: exactly `capacity` admits when refill cannot credit mid-burst
- Fail-closed HTTP 429 (JSON, `Retry-After`, `X-RateLimit-Remaining`) distinct from admitted SSE streams
- Nearest-rank p50/p95/p99 of observed request latency, partitioned by admitted vs rate-limited
- Telemetry isolation: LLM percentile samples accrue only for admitted turns

- Helm named templates (`define` / `include`) and DNS-1123 names (`trunc 63 | trimSuffix "-"`)
- Values overlay with deep merge; Ingress and HPA omitted when disabled
- HPA ownership of replica count: omit Deployment `spec.replicas` when autoscaling is enabled
- ConfigMap for non-secret config; secret-shaped keys fail the chart policy

## What's implemented

- `packages/agent-core`: framework-free agent loop, tool registry, session store, telemetry, and a mock provider
- `packages/llm`: key-gated Vercel AI SDK provider with a mock fallback
- `packages/config`: Zod-validated env/config loader shared across the workspace
- `packages/rate-limiter`: token-bucket + sliding-window limiter and a concurrency semaphore, with refill, burst, and concurrency covered by tests
- `packages/store-redis`: Redis-backed conversation store (atomic list appends, Zod-validated reads, sliding TTL) and a distributed fixed-window rate limiter behind a `RedisPort`, with an in-memory fallback used in tests
- `apps/server` (Hono): `POST /agent/turn` SSE streaming, `GET /healthz`, rate-limit middleware returning 429
- `apps/server`: `GET /telemetry` (p50/p95/p99) and structured JSON logging
- `apps/server` Dockerfile: multi-stage, non-root, HEALTHCHECK, `.dockerignore`
- Per-package READMEs + a sequence diagram of the agent loop (`assertWellFormed`, `toMermaid`, `acceptsTrace`)

- `packages/agent-core` — the framework-free agent loop, tools, and telemetry
- `deploy/k8s` — namespace, server Deployment + Service, ConfigMap/Secret, Redis StatefulSet
- `apps/console` — a Next.js chat UI (planned)
- Kubernetes namespace isolation and label selector contracts: Service and Deployment `matchLabels` must be a subset of the pod template labels
- ConfigMap versus Secret: non-confidential config as strings, credentials via `secretKeyRef`
- StatefulSet stable identity: ordinal DNS, headless Service (`clusterIP: None`), `volumeClaimTemplates`
- Liveness versus readiness probes
- Pod security: non-root uid via `runAsNonRoot` / `runAsUser`
- `deploy/k8s`: namespace, server Deployment + Service, ConfigMap/Secret, Redis StatefulSet
- `fsGroup` on a StatefulSet so a non-root uid can write AOF on a default RWO PVC
- Local cluster images: pinned tag plus `imagePullPolicy: Never` after `kind load` / `minikube image load`

- Dockerfile/workspace copy reconciliation: every `workspace:*` dependency of the server must appear in a `COPY` or the image is incomplete
- Shift-left CI: lint, compile the container image, then `helm lint` + `helm template` as a cluster-free dry-run
- Kubernetes deploy invariants on rendered YAML: DNS-1123 names, label/selector subset, pinned image tags, `/healthz` probes
- `deploy/ci/smoke-chart`: Helm chart the CI `helm lint` + `helm template` smoke renders without a cluster
- Dockerfile/workspace copy reconciliation: every `workspace:*` dependency of the server must appear in a `COPY` or the image is incomplete
- Shift-left CI: lint, compile the container image, then `helm lint` + `helm template` as a cluster-free dry-run
- Kubernetes deploy invariants on rendered YAML: DNS-1123 names, label/selector subset, pinned image tags, `/healthz` probes
- CI: ESLint, docker build (no push, pinned sha tag), helm lint + helm template smoke on `deploy/ci/smoke-chart`

- `deploy/k8s/traffic.yaml` — Ingress, CPU HPA, and liveness/readiness probes on `/healthz`
- Kubernetes Ingress: host/path routing with a named-port backend bound to a ClusterIP Service
- Horizontal Pod Autoscaler: CPU utilization scaling, which requires a cpu request as the utilization denominator
- Kubelet liveness vs readiness on `GET /healthz`, with detection window `failureThreshold * periodSeconds` (readiness faster than liveness) and `terminationGracePeriodSeconds` covering drain
- `deploy/k8s`: Ingress + HPA + readiness/liveness probes on `/healthz`

- Open-loop concurrent burst generation against an HTTP handler: all arrivals in flight, then join
- Token-bucket burst ceiling under concurrent arrivals: exactly `capacity` admits when refill cannot credit mid-burst
- Fail-closed HTTP 429 (JSON, `Retry-After`, `X-RateLimit-Remaining`) distinct from admitted SSE streams
- Nearest-rank p50/p95/p99 of observed request latency, partitioned by admitted vs rate-limited
- Telemetry isolation: LLM percentile samples accrue only for admitted turns
- Open-loop concurrent burst generation against an HTTP handler: all arrivals in flight, then join
- Token-bucket burst ceiling under concurrent arrivals: exactly `capacity` admits when refill cannot credit mid-burst
- Fail-closed HTTP 429 (JSON, `Retry-After`, `X-RateLimit-Remaining`) distinct from admitted SSE streams
- Nearest-rank p50/p95/p99 of observed request latency, partitioned by admitted vs rate-limited
- Telemetry isolation: LLM percentile samples accrue only for admitted turns
- Open-loop concurrent burst generation against an HTTP handler: all arrivals in flight, then join
- Token-bucket burst ceiling under concurrent arrivals: exactly `capacity` admits when refill cannot credit mid-burst
- Fail-closed HTTP 429 (JSON, `Retry-After`, `X-RateLimit-Remaining`) distinct from admitted SSE streams
- Nearest-rank p50/p95/p99 of observed request latency, partitioned by admitted vs rate-limited
- Telemetry isolation: LLM percentile samples accrue only for admitted turns
- Open-loop concurrent burst generation against an HTTP handler: all arrivals in flight, then join
- Token-bucket burst ceiling under concurrent arrivals: exactly `capacity` admits when refill cannot credit mid-burst
- Fail-closed HTTP 429 (JSON, `Retry-After`, `X-RateLimit-Remaining`) distinct from admitted SSE streams
- Nearest-rank p50/p95/p99 of observed request latency, partitioned by admitted vs rate-limited
- Telemetry isolation: LLM percentile samples accrue only for admitted turns
- `apps/server`: `fireTurnBurst` integration/load harness hitting the SSE endpoint through the limiter (429 under burst, telemetry percentiles)

- Helm named templates (`define` / `include`) and DNS-1123 names (`trunc 63 | trimSuffix "-"`)
- Values overlay with deep merge; Ingress and HPA omitted when disabled
- HPA ownership of replica count: omit Deployment `spec.replicas` when autoscaling is enabled
- ConfigMap for non-secret config; secret-shaped keys fail the chart policy
- Helm named templates (`define` / `include`) and DNS-1123 names (`trunc 63 | trimSuffix "-"`)
- Values overlay with deep merge; Ingress and HPA omitted when disabled
- HPA ownership of replica count: omit Deployment `spec.replicas` when autoscaling is enabled
- ConfigMap for non-secret config; secret-shaped keys fail the chart policy
- Helm named templates (`define` / `include`) and DNS-1123 names (`trunc 63 | trimSuffix "-"`)
- Values overlay with deep merge; Ingress and HPA omitted when disabled
- HPA ownership of replica count: omit Deployment `spec.replicas` when autoscaling is enabled
- ConfigMap for non-secret config; secret-shaped keys fail the chart policy
- `deploy/helm/agent-kit`: Helm chart templating Deployment, Service, Ingress, HPA, and ConfigMap from `values.yaml`

## Cluster apply

```bash
docker build -f apps/server/Dockerfile -t agent-server .
`deploy/k8s/traffic.yaml` is the cluster edge: nginx Ingress `agent.local/` to `Service/server` (named `http` port), and an `autoscaling/v2` HPA on 70% CPU (min 2 / max 8, request `100m`). Liveness and readiness both `GET /healthz`. Detection window is `failureThreshold * periodSeconds` (readiness 10s, liveness 60s). Apply with `kubectl apply -f deploy/k8s/traffic.yaml`.
```

## Cluster apply

```bash
helm template agent deploy/helm/agent-kit
```

## Getting started

```bash
pnpm install
pnpm --filter @agent/core demo
pnpm --filter @agent/server dev
```

Run the tests with `pnpm install && pnpm test`. Typecheck with `pnpm typecheck`.

See each package's README for details.
