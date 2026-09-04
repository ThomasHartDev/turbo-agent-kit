# Local processes vs intended prod topology

Same four logical pieces: Redis, the Hono server, the Next console, and telemetry. Charts are not in this tree yet. Until they are, run the processes on the laptop. Tracing is in-process OpenTelemetry; OTLP export stays off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Conversation state is `InMemoryConversationStore`. `@agent/store-redis` is the package you would wire for a shared Redis.

The intended split once Compose and Helm land: one replica per service on a laptop, with an in-stack collector locally, versus a cluster install. Redis as a StatefulSet, 1. The server as a Deployment 2–8, HPA, Ingress. Collector not in the chart, left to the cluster. Helm is a HorizontalPodAutoscaler on the server only.

## Local (processes)

```
pnpm --filter @agent/server dev
pnpm --filter @agent/console dev
curl -sf http://127.0.0.1:8787/healthz
```

Console: `http://127.0.0.1:3001`.

## Intended prod

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at the cluster collector. Redis stays at 1 so list-append keys and the Lua rate-limit counter keep a stable network identity.

| Service        | Local (intended Compose)  | Prod (intended Helm)         |
| -------------- | ------------------------- | ---------------------------- |
| redis          | 1 replica                 | StatefulSet, 1               |
| otel-collector | 1 replica                 | not in the chart             |
| server         | 1 replica, `GET /healthz` | Deployment 2–8, HPA, Ingress |
| console        | 1 replica                 | Deployment, 1                |

## Helm

```bash
helm upgrade --install agent-kit deploy/helm/agent-kit
```
