import type { RateLimitResult } from "@agent/rate-limiter";
import type { RedisPort } from "./redis-port";

// INCR is atomic, but a crash between the increment and the expiry would leave a
// counter that never resets. Doing both in one Lua call closes that window: the
// TTL is set exactly once, on the hit that creates the key.
export const FIXED_WINDOW_SCRIPT = `local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}`;

export interface AsyncRateLimiter {
  tryAcquire(key: string): Promise<RateLimitResult>;
}

export interface RedisRateLimiterOptions {
  limit: number;
  windowMs: number;
  keyPrefix?: string;
}

// Fixed-window counter shared across every node pointing at the same Redis. The
// tradeoff versus a sliding-window log is memory: one integer per window instead
// of a timestamp per request, at the cost of up to 2x the limit across a boundary.
export class RedisRateLimiter implements AsyncRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisPort,
    options: RedisRateLimiterOptions,
  ) {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new RangeError(`limit must be a positive integer, got ${options.limit}`);
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive integer, got ${options.windowMs}`);
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.prefix = options.keyPrefix ?? "ratelimit:";
  }

  async tryAcquire(key: string): Promise<RateLimitResult> {
    const raw = await this.redis.eval(
      FIXED_WINDOW_SCRIPT,
      [this.prefix + key],
      [String(this.windowMs)],
    );
    const [count, ttl] = raw as [number, number];
    const ok = count <= this.limit;
    return {
      ok,
      remaining: Math.max(0, this.limit - count),
      retryAfterMs: ok ? 0 : Math.max(0, ttl),
    };
  }
}
