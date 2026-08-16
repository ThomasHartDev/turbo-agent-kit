import { context, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
  type SpanProcessor,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export const TRACER_NAME = "turbo-agent-kit";

export interface TracingOptions {
  serviceName?: string;
  /** Override OTEL_EXPORTER_OTLP_ENDPOINT. null skips OTLP. */
  otlpEndpoint?: string | null;
  consoleExporter?: boolean;
  spanProcessors?: SpanProcessor[];
  exporters?: SpanExporter[];
}

export interface TracingHandle {
  provider: NodeTracerProvider;
  otlpEnabled: boolean;
  serviceName: string;
  shutdown: () => Promise<void>;
}

let active: TracingHandle | null = null;

export function resolveOtlpEndpoint(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit === null) return undefined;
  if (typeof explicit === "string") {
    const t = explicit.trim();
    return t.length > 0 ? t : undefined;
  }
  const fromEnv = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

function otlpTracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

/** OTLP export is off unless endpoint is set (arg or env). */
export function initTracing(options: TracingOptions = {}): TracingHandle {
  if (active) return active;

  const serviceName =
    options.serviceName?.trim() || process.env.OTEL_SERVICE_NAME?.trim() || "turbo-agent-kit";
  const otlpEndpoint = resolveOtlpEndpoint(options.otlpEndpoint);
  const logSpans = options.consoleExporter === true || process.env.OTEL_LOG_SPANS === "1";

  const processors: SpanProcessor[] = [...(options.spanProcessors ?? [])];
  for (const exporter of options.exporters ?? []) {
    processors.push(new SimpleSpanProcessor(exporter));
  }
  if (otlpEndpoint) {
    processors.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: otlpTracesUrl(otlpEndpoint) })),
    );
  }
  if (logSpans) {
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: processors,
  });
  provider.register();

  active = {
    provider,
    otlpEnabled: Boolean(otlpEndpoint),
    serviceName,
    shutdown: async () => {
      await provider.shutdown();
      // register() sets globals; without disable(), a later register() is a no-op
      trace.disable();
      context.disable();
      active = null;
    },
  };
  return active;
}

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

export function isTracingInitialized(): boolean {
  return active !== null;
}

export function otlpEnabled(): boolean {
  return active?.otlpEnabled ?? false;
}

export async function resetTracingForTests(): Promise<void> {
  if (active) {
    await active.shutdown();
  } else {
    trace.disable();
    context.disable();
  }
  active = null;
}
