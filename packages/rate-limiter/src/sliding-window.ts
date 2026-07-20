import {
  assertPositive,
  assertPositiveInt,
  type Clock,
  type RateLimiter,
  type RateLimitResult,
} from "./types";

export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
  clock?: Clock;
}

// Exact sliding-window log: keeps a timestamp per admitted unit and prunes on
// read. Precise at the window edge, unlike a fixed-window counter that lets 2x
// the limit through across a boundary. Memory is O(limit) per key.
export class SlidingWindowLog implements RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: Clock;
  private readonly hits: number[] = [];

  constructor(options: SlidingWindowOptions) {
    assertPositiveInt("limit", options.limit);
    assertPositive("windowMs", options.windowMs);
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? Date.now;
  }

  get count(): number {
    this.prune(this.clock());
    return this.hits.length;
  }

  tryAcquire(cost = 1): RateLimitResult {
    assertPositiveInt("cost", cost);
    if (cost > this.limit) {
      throw new RangeError(`cost ${cost} exceeds window limit ${this.limit}`);
    }
    const now = this.clock();
    this.prune(now);

    if (this.hits.length + cost <= this.limit) {
      for (let i = 0; i < cost; i++) this.hits.push(now);
      return { ok: true, remaining: this.limit - this.hits.length, retryAfterMs: 0 };
    }

    // Slots free as old hits age out. To admit `cost` we need `need` of the
    // oldest hits to leave the window; the newest of those expires last.
    const need = this.hits.length + cost - this.limit;
    const freesAt = this.hits[need - 1] + this.windowMs;
    return { ok: false, remaining: 0, retryAfterMs: freesAt - now };
  }

  private prune(now: number): void {
    const threshold = now - this.windowMs;
    let drop = 0;
    while (drop < this.hits.length && this.hits[drop] <= threshold) drop++;
    if (drop > 0) this.hits.splice(0, drop);
  }
}
