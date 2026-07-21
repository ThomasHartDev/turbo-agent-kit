import { describe, expect, it } from "vitest";
import { InMemoryRedis } from "./in-memory-redis";
import { RedisRateLimiter } from "./rate-limiter";
import { createRateLimiter } from "./index";

function manualClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("RedisRateLimiter", () => {
  it("admits up to the limit then denies within the window", async () => {
    const limiter = new RedisRateLimiter(new InMemoryRedis(), { limit: 3, windowMs: 1_000 });
    for (let i = 0; i < 3; i++) {
      const r = await limiter.tryAcquire("user-1");
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(2 - i);
    }
    const denied = await limiter.tryAcquire("user-1");
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window expires", async () => {
    const clock = manualClock();
    const limiter = new RedisRateLimiter(new InMemoryRedis(clock.now), {
      limit: 1,
      windowMs: 1_000,
    });
    expect((await limiter.tryAcquire("k")).ok).toBe(true);
    expect((await limiter.tryAcquire("k")).ok).toBe(false);
    clock.advance(1_000);
    expect((await limiter.tryAcquire("k")).ok).toBe(true);
  });

  it("reports retryAfterMs as the remaining window", async () => {
    const clock = manualClock();
    const limiter = new RedisRateLimiter(new InMemoryRedis(clock.now), {
      limit: 1,
      windowMs: 1_000,
    });
    await limiter.tryAcquire("k");
    clock.advance(300);
    const denied = await limiter.tryAcquire("k");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBe(700);
  });

  it("keeps separate keys on independent counters", async () => {
    const limiter = new RedisRateLimiter(new InMemoryRedis(), { limit: 1, windowMs: 1_000 });
    expect((await limiter.tryAcquire("a")).ok).toBe(true);
    expect((await limiter.tryAcquire("b")).ok).toBe(true);
    expect((await limiter.tryAcquire("a")).ok).toBe(false);
  });

  it("rejects invalid options", () => {
    expect(() => new RedisRateLimiter(new InMemoryRedis(), { limit: 0, windowMs: 1_000 })).toThrow(
      RangeError,
    );
    expect(() => new RedisRateLimiter(new InMemoryRedis(), { limit: 5, windowMs: -1 })).toThrow(
      RangeError,
    );
  });
});

describe("createRateLimiter", () => {
  it("falls back to an in-memory limiter with no client", async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000 });
    expect((await limiter.tryAcquire("x")).ok).toBe(true);
    expect((await limiter.tryAcquire("x")).ok).toBe(true);
    expect((await limiter.tryAcquire("x")).ok).toBe(false);
  });
});
