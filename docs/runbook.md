# Local Compose vs prod Helm

Same four logical pieces: Redis, the Hono server, the Next console, and telemetry. Compose is one replica per service on a laptop, with an in-stack OTLP collector and `service_healthy` gates. Helm is a cluster install: Redis as a StatefulSet, the server as a Deployment behind a HorizontalPodAutoscaler (2–8), and the collector left to the cluster.

## Local (Compose)

```
docker compose up --build --wait
curl -sf http://127.0.0.1:8787/healthz
docker compose down
```

Console: `http://127.0.0.1:3001`. Without Compose: `pnpm --filter @agent/server dev` and `pnpm --filter @agent/console dev`. Secrets stay interpolated (`${OPENAI_API_KEY:-}`).

## Prod (Helm)

```
helm template agent-kit deploy/helm/agent-kit
helm upgrade --install agent-kit deploy/helm/agent-kit
kubectl rollout status deployment/agent-kit
```

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at the cluster collector. Redis stays at 1 so list-append keys and the Lua rate-limit counter keep a stable network identity.

| Service        | Compose                   | Helm                         |
| -------------- | ------------------------- | ---------------------------- |
| redis          | 1 replica                 | StatefulSet, 1               |
| otel-collector | 1 replica                 | not in the chart             |
| server         | 1 replica, `GET /healthz` | Deployment 2–8, HPA, Ingress |
| console        | 1 replica                 | Deployment, 1                |
