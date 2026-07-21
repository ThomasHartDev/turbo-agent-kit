// The narrow slice of a Redis client this package needs. Depending on the port
// instead of a concrete client keeps the store and limiter testable with an
// in-memory fake and lets any client (ioredis, node-redis) plug in via a thin
// adapter. `eval` runs a server-side Lua script for atomic check-and-increment.
export interface RedisPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}
