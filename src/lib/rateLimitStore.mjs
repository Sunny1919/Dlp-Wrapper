// © Author: aliyie
// https://discord.gg/aerox

// Shared helper so both the general limiter (app.mjs) and the download
// limiter (media.mjs) use Redis when it's available and fall back to
// express-rate-limit's built-in in-memory store otherwise. Call this after
// index.mjs has already attempted the Redis connection (see index.mjs for
// why the dynamic import ordering matters here).
import { RedisStore } from 'rate-limit-redis';
import { getRedisClientSync } from './redis.mjs';

/**
 * `prefix` must be distinct per limiter instance — two limiters sharing a
 * prefix (and thus the same Redis keys per client IP) would silently merge
 * into a single shared counter instead of two independent ones.
 */
export function buildRateLimitStore(prefix) {
  const redisClient = getRedisClientSync();
  if (!redisClient) return undefined; // express-rate-limit defaults to MemoryStore
  return new RedisStore({
    prefix,
    sendCommand: (...args) => redisClient.sendCommand(args),
  });
}
