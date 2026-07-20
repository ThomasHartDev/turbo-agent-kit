import { describe, expect, it } from "vitest";
import { TokenBucket } from "./token-bucket";

function manualClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("TokenBucket", () => {
  it("starts full and allows a burst up to capacity", () => {
    const clock = manualClock();
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, clock: clock.now });
    for (let i = 0; i < 5; i++) expect(bucket.tryAcquire().ok).toBe(true);
    const denied = bucket.tryAcquire();
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("refills continuously and clamps at capacity", () => {
    const clock = manualClock();
    const bucket = new TokenBucket({
      capacity: 10,
      refillPerSecond: 2,
      clock: clock.now,
      initialTokens: 0,
    });
    expect(bucket.tryAcquire().ok).toBe(false);
    clock.advance(500); // 0.5s * 2/s = 1 token
    expect(bucket.tryAcquire().ok).toBe(true);
    clock.advance(60_000); // would refill 120, capped at 10
    expect(bucket.availableTokens).toBe(10);
  });

  it("reports retryAfterMs equal to the time to accrue the deficit", () => {
    const clock = manualClock();
    const bucket = new TokenBucket({
      capacity: 4,
      refillPerSecond: 4,
      clock: clock.now,
      initialTokens: 0,
    });
    const r = bucket.tryAcquire(2); // need 2 tokens, 4/s -> 250ms/token -> 500ms
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(500);
    clock.advance(r.retryAfterMs);
    expect(bucket.tryAcquire(2).ok).toBe(true);
  });

  it("spends multiple tokens on a single acquire", () => {
    const clock = manualClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, clock: clock.now });
    expect(bucket.tryAcquire(3).ok).toBe(true);
    expect(bucket.tryAcquire(1).ok).toBe(false);
  });

  it("ignores a clock that moves backward", () => {
    const clock = manualClock(1000);
    const bucket = new TokenBucket({
      capacity: 5,
      refillPerSecond: 1,
      clock: clock.now,
      initialTokens: 2,
    });
    clock.advance(-500);
    expect(bucket.availableTokens).toBe(2);
    clock.advance(1500); // net +1000ms from start -> +1 token
    expect(bucket.availableTokens).toBe(3);
  });

  it("rejects invalid construction and costs", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 5, refillPerSecond: -1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 5, refillPerSecond: 1, initialTokens: 6 })).toThrow(
      RangeError,
    );
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 });
    expect(() => bucket.tryAcquire(0)).toThrow(RangeError);
    expect(() => bucket.tryAcquire(2.5)).toThrow(RangeError);
    expect(() => bucket.tryAcquire(6)).toThrow(RangeError);
  });
});
