// © Author: aliyie
// https://discord.gg/aerox

// Per-IP quotas: a longer-window ceiling (e.g. N downloads per day) on top
// of the short-window rate limiter in app.mjs/media.mjs. Opt-in via
// QUOTA_ENABLED — a short burst limit and a daily ceiling solve different
// problems, and not every self-hoster wants the latter.
//
// Uses Redis INCR+PEXPIRE when available, so counts survive restarts and
// are shared across instances; otherwise an in-memory Map scoped to this
// process only.
import { getRedisClient } from './redis.mjs';
import { logger } from './logger.mjs';

const memoryStore = new Map(); // key -> { count, resetAt }

function memoryIncrement(key, windowMs) {
  const now = Date.now();
  const entry = memoryStore.get(key);
  if (!entry || now > entry.resetAt) {
    const fresh = { count: 1, resetAt: now + windowMs };
    memoryStore.set(key, fresh);
    return fresh;
  }
  entry.count += 1;
  return entry;
}

/**
 * Increments the counter for `key` and reports whether it's now over `max`.
 * Returns { count, resetAt, limited }.
 */
export async function incrementQuota(key, windowMs, max) {
  const redisKey = `dlpwrapper:quota:${key}`;
  const redis = await getRedisClient();

  if (redis) {
    try {
      const count = await redis.incr(redisKey);
      if (count === 1) {
        await redis.pExpire(redisKey, windowMs);
      }
      const ttl = await redis.pTTL(redisKey);
      const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
      return { count, resetAt, limited: count > max };
    } catch (err) {
      logger.warn({ err }, 'Redis quota check failed — falling back to in-memory for this request');
    }
  }

  const entry = memoryIncrement(redisKey, windowMs);
  return { count: entry.count, resetAt: entry.resetAt, limited: entry.count > max };
}

// Safety-net sweep for the in-memory fallback.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (now > entry.resetAt) memoryStore.delete(key);
  }
}, 60_000).unref();
