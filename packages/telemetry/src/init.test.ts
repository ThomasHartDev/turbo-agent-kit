import { afterAll, describe, expect, it } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
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
});
