import { serve } from "@hono/node-server";
import { createLLMProvider } from "@agent/llm";
import { initTracing } from "@agent/telemetry";
import { createApp } from "./create-app";
import { createLogger, parseLogLevel } from "./logger";

export { createApp } from "./create-app";
export type { App, AppDeps } from "./create-app";
export { rateLimitMiddleware } from "./rate-limit";
export { createLogger, parseLogLevel } from "./logger";
export type { Logger, LogLevel, LoggerOptions } from "./logger";
export { fireTurnBurst, latencySummary, parseSseFrames, summarizeBurst } from "./load-burst";
export type { BurstOptions, BurstResult, LoadSample, SseEvent } from "./load-burst";

const port = Number(process.env.PORT ?? 8787);
const logger = createLogger({ level: parseLogLevel(process.env.LOG_LEVEL) });

// Only start a listener when this file is the process entrypoint.
const isMain =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("/src/index.ts") || process.argv[1].endsWith("/dist/index.js"));

if (isMain) {
  const tracing = initTracing({ serviceName: process.env.OTEL_SERVICE_NAME ?? "agent-server" });
  logger.info("tracing_init", {
    otlpEnabled: tracing.otlpEnabled,
    serviceName: tracing.serviceName,
  });
  const app = createApp({ llm: createLLMProvider(), logger });
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info("listening", { port: info.port });
  });
}
