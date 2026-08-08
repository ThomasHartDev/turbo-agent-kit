import { SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { Telemetry, type TelemetryEvent } from "@agent/core";
import { getTracer } from "./init";

export type SpanEvent = Omit<TelemetryEvent, "at">;

/**
 * Dual-writes latency samples and OTel spans. Children attach to the active
 * span (agent.turn). Durations are backdated from measured `ms`.
 */
export class SpanTelemetry extends Telemetry {
  record(e: SpanEvent): void {
    const endMs = Date.now();
    const duration = Number.isFinite(e.ms) ? Math.max(0, e.ms) : 0;
    const startMs = endMs - duration;
    const span = getTracer().startSpan(`agent.${e.type}`, {
      kind: SpanKind.INTERNAL,
      startTime: startMs,
      attributes: {
        "agent.span_type": e.type,
        "agent.channel": e.channel,
        "agent.detail": e.detail,
        "agent.duration_ms": duration,
      } satisfies Attributes,
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end(endMs);
    super.record({ ...e, ms: duration });
  }
}
