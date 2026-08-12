import type { RedisPort } from "./redis-port";
import { InMemoryRedis } from "./in-memory-redis";
import {
  RedisConversationStore,
  type AsyncConversationStore,
  type RedisConversationStoreOptions,
} from "./conversation-store";
import {
  RedisRateLimiter,
  type AsyncRateLimiter,
  type RedisRateLimiterOptions,
} from "./rate-limiter";

export * from "./redis-port";
export * from "./in-memory-redis";
export * from "./conversation-store";
export * from "./rate-limiter";

export interface StoreConfig extends RedisConversationStoreOptions {
  redis?: RedisPort;
}

export function createConversationStore(config: StoreConfig = {}): AsyncConversationStore {
  const { redis, ...options } = config;
  return new RedisConversationStore(redis ?? new InMemoryRedis(), options);
}

export interface RateLimiterConfig extends RedisRateLimiterOptions {
  redis?: RedisPort;
}

export function createRateLimiter(config: RateLimiterConfig): AsyncRateLimiter {
  const { redis, ...options } = config;
  return new RedisRateLimiter(redis ?? new InMemoryRedis(), options);
}
