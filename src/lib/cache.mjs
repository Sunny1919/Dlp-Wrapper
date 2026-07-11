// © Author: aliyie
// https://discord.gg/aerox

// Caches /media/info and /media/direct-url responses so repeat requests for
// the same url (+format) skip a fresh yt-dlp invocation. Uses Redis when
// REDIS_URL is set (shared across instances, survives restarts), otherwise
// an in-memory Map capped at CACHE_MAX_ITEMS with basic LRU-ish eviction.
// Downloads are never cached — they're streamed, not stored.
import { createHash } from 'node:crypto';
import { getRedisClient } from './redis.mjs';
import { logger } from './logger.mjs';

const MEMORY_MAX_ITEMS = Number(process.env.CACHE_MAX_ITEMS ?? 500);
const memoryStore = new Map(); // key -> { value, expiresAt }

function hash(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 24);
}

function keyFor(namespace, parts) {
  return `dlpwrapper:cache:${namespace}:${parts.map(hash).join(':')}`;
}

function memoryGet(key) {
  const entry = memoryStore.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return undefined;
  }
  return entry.value;
}

function memorySet(key, value, ttlMs) {
  if (memoryStore.size >= MEMORY_MAX_ITEMS && !memoryStore.has(key)) {
    const oldestKey = memoryStore.keys().next().value;
    memoryStore.delete(oldestKey);
  }
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Returns the cached value for (namespace, parts), or undefined on a miss. */
export async function cacheGet(namespace, parts) {
  const key = keyFor(namespace, parts);
  const redis = await getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(key);
      return raw ? JSON.parse(raw) : undefined;
    } catch (err) {
      logger.warn({ err }, 'Redis cache read failed — treating as a miss');
      return undefined;
    }
  }
  return memoryGet(key);
}

/** Stores `value` for (namespace, parts) with a TTL in milliseconds. */
export async function cacheSet(namespace, parts, value, ttlMs) {
  const key = keyFor(namespace, parts);
  const redis = await getRedisClient();
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(value), { PX: ttlMs });
      return;
    } catch (err) {
      logger.warn({ err }, 'Redis cache write failed');
      return;
    }
  }
  memorySet(key, value, ttlMs);
}

// Safety-net sweep for the in-memory fallback so it doesn't hold expired
// entries indefinitely between reads.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (now > entry.expiresAt) memoryStore.delete(key);
  }
}, 60_000).unref();
