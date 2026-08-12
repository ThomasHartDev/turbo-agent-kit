import type { MiddlewareHandler } from "hono";
import type { RateLimiter, RateLimitResult } from "@agent/rate-limiter";

// fail closed: limiter errors still reject rather than open the floodgates

export function rateLimitMiddleware(limiter: RateLimiter, cost = 1): MiddlewareHandler {
  return async (c, next) => {
    let result: RateLimitResult;
    try {
      result = limiter.tryAcquire(cost);
    } catch {
      return c.json({ error: "rate_limit_error" }, 500);
    }

    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.ok) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        {
          error: "rate_limited",
          retryAfterMs: result.retryAfterMs,
          remaining: result.remaining,
        },
        429,
      );
    }

    await next();
  };
}
