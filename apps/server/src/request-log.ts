import type { MiddlewareHandler } from "hono";
import type { Logger } from "./logger";

export function requestLogMiddleware(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    const incoming = c.req.header("x-request-id");
    const requestId =
      incoming && incoming.trim().length > 0 ? incoming.trim().slice(0, 128) : crypto.randomUUID();
    c.header("X-Request-Id", requestId);
    c.set("requestId", requestId);

    await next();

    const status = c.res.status;
    const durationMs = Math.round(performance.now() - started);
    const fields = {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs,
    };
    if (status >= 500) {
      logger.error("request", fields);
    } else if (status >= 400) {
      logger.warn("request", fields);
    } else {
      logger.info("request", fields);
    }
  };
}
