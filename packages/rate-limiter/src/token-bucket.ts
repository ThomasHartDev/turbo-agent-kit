import {
  assertPositive,
  assertPositiveInt,
  type Clock,
  type RateLimiter,
  type RateLimitResult,
} from "./types";

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  clock?: Clock;
  initialTokens?: number;
}

export class TokenBucket implements RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock: Clock;
  private tokens: number;
  private last: number;

  constructor(options: TokenBucketOptions) {
    assertPositive("capacity", options.capacity);
    assertPositive("refillPerSecond", options.refillPerSecond);
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerSecond / 1000;
    this.clock = options.clock ?? Date.now;

    const initial = options.initialTokens ?? options.capacity;
    if (initial < 0 || initial > options.capacity) {
      throw new RangeError(`initialTokens must be within [0, capacity], got ${initial}`);
    }
    this.tokens = initial;
    this.last = this.clock();
  }

  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  tryAcquire(cost = 1): RateLimitResult {
    assertPositiveInt("cost", cost);
    if (cost > this.capacity) {
      throw new RangeError(`cost ${cost} exceeds bucket capacity ${this.capacity}`);
    }
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { ok: true, remaining: Math.floor(this.tokens), retryAfterMs: 0 };
    }
    const deficit = cost - this.tokens;
    const retryAfterMs = Math.ceil(deficit / this.refillPerMs);
    return { ok: false, remaining: Math.floor(this.tokens), retryAfterMs };
  }

  // Continuous refill from elapsed wall time. A clock that jumps backward is
  // ignored rather than draining the bucket or freezing `last` in the future.
  private refill(): void {
    const now = this.clock();
    if (now <= this.last) return;
    const gained = (now - this.last) * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.last = now;
  }
}
