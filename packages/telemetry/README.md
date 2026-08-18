# @agent/telemetry

OpenTelemetry adapter. `withAgentTurn` opens an `agent.turn` span; LLM and tool work nest via context. `SpanTelemetry` implements core `Telemetry`. OTLP stays off until an endpoint is set.

```ts
import { initTracing, SpanTelemetry, withAgentTurn } from "@agent/telemetry";
initTracing();
await withAgentTurn({ conversationId }, () => runAgentTurn(convo, text, llm, new SpanTelemetry()));
```

## Tests

```
pnpm --filter @agent/telemetry test
```
