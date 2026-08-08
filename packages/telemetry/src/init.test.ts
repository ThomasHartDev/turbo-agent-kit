import { afterAll, afterEach, describe, expect, it } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  getTracer,
  initTracing,
  isTracingInitialized,
  otlpEnabled,
  resetTracingForTests,
  resolveOtlpEndpoint,
} from "./init";

describe("resolveOtlpEndpoint", () => {
  it("gates empty, null, env, and explicit values", () => {
    expect(resolveOtlpEndpoint(undefined, {})).toBeUndefined();
    expect(resolveOtlpEndpoint(null, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" })).toBeUndefined();
    expect(resolveOtlpEndpoint("  ", {})).toBeUndefined();
    expect(
      resolveOtlpEndpoint("http://explicit:4318", {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318",
      }),
    ).toBe("http://explicit:4318");
    expect(
      resolveOtlpEndpoint(undefined, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "  http://collector:4318  ",
      }),
    ).toBe("http://collector:4318");
  });
});

describe("initTracing", () => {
  afterEach(async () => resetTracingForTests());
  afterAll(async () => resetTracingForTests());

  it("registers once, leaves OTLP off without endpoint, and is idempotent", () => {
    const handle = initTracing({
      serviceName: "test-svc",
      otlpEndpoint: null,
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    expect(handle.otlpEnabled).toBe(false);
    expect(handle.serviceName).toBe("test-svc");
    expect(isTracingInitialized()).toBe(true);
    expect(otlpEnabled()).toBe(false);
    expect(initTracing({ serviceName: "other" })).toBe(handle);
  });

  it("sets otlpEnabled when an endpoint is provided without a live collector", () => {
    const handle = initTracing({
      serviceName: "otlp-flag",
      otlpEndpoint: "http://127.0.0.1:4318",
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    expect(handle.otlpEnabled).toBe(true);
    expect(otlpEnabled()).toBe(true);
  });

  it("re-exports spans after shutdown and a second initTracing", async () => {
    const first = new InMemorySpanExporter();
    initTracing({
      serviceName: "reinit-a",
      otlpEndpoint: null,
      spanProcessors: [new SimpleSpanProcessor(first)],
    });
    getTracer().startSpan("before-shutdown").end();
    expect(first.getFinishedSpans().map((s) => s.name)).toContain("before-shutdown");

    await resetTracingForTests();
    expect(isTracingInitialized()).toBe(false);

    const second = new InMemorySpanExporter();
    initTracing({
      serviceName: "reinit-b",
      otlpEndpoint: null,
      spanProcessors: [new SimpleSpanProcessor(second)],
    });
    getTracer().startSpan("after-reinit").end();
    expect(second.getFinishedSpans().map((s) => s.name)).toContain("after-reinit");
    expect(isTracingInitialized()).toBe(true);
  });
});
