import type { RedisPort } from "./redis-port";
import { FIXED_WINDOW_SCRIPT } from "./rate-limiter";

type Clock = () => number;

interface Entry {
  value: string | string[];
  expireAt?: number; // absolute ms; undefined means no expiry
}

// In-process RedisPort used two ways: as the fallback substrate when no real
// client is configured, and as the test double in CI. TTLs are enforced lazily
// on access against an injectable clock so time-based tests stay deterministic.
export class InMemoryRedis implements RedisPort {
  private readonly map = new Map<string, Entry>();
  private readonly clock: Clock;

  constructor(clock: Clock = Date.now) {
    this.clock = clock;
  }

  private live(key: string): Entry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== undefined && this.clock() >= entry.expireAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.live(key);
    if (!entry || typeof entry.value !== "string") return null;
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expireAt = ttlSeconds !== undefined ? this.clock() + ttlSeconds * 1000 : undefined;
    this.map.set(key, { value, expireAt });
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.map.delete(key);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const entry = this.live(key);
    if (entry && Array.isArray(entry.value)) {
      entry.value.push(...values);
      return entry.value.length;
    }
    this.map.set(key, { value: [...values] });
    return values.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const entry = this.live(key);
    if (!entry || !Array.isArray(entry.value)) return [];
    const list = entry.value;
    const from = start < 0 ? Math.max(list.length + start, 0) : start;
    const to = stop < 0 ? list.length + stop : Math.min(stop, list.length - 1);
    if (from > to) return [];
    return list.slice(from, to + 1);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.live(key);
    if (entry) entry.expireAt = this.clock() + ttlSeconds * 1000;
  }

  // The real limiter runs FIXED_WINDOW_SCRIPT on the server. Here we reproduce
  // its INCR + PEXPIRE-on-first-hit + PTTL semantics so the TS wrapper's math is
  // genuinely exercised without a Lua interpreter. Only the shipped script runs.
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (script !== FIXED_WINDOW_SCRIPT) {
      throw new Error("InMemoryRedis.eval only supports the fixed-window script");
    }
    const key = keys[0]!;
    const windowMs = Number(args[0]);
    const now = this.clock();
    const entry = this.live(key);
    if (!entry || typeof entry.value !== "string") {
      this.map.set(key, { value: "1", expireAt: now + windowMs });
      return [1, windowMs];
    }
    const count = Number(entry.value) + 1;
    entry.value = String(count);
    const ttl = entry.expireAt !== undefined ? entry.expireAt - now : -1;
    return [count, ttl];
  }
}
