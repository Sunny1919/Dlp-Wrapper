// © Author: aliyie
// https://discord.gg/aerox

// Shared Redis client used by cache.mjs, quota.mjs, and the rate limiter in
// app.mjs. Redis is entirely optional — every consumer falls back to an
// in-memory equivalent if REDIS_URL isn't set or the connection fails, so a
// single instance works fine without it and a multi-instance deployment
// gains shared state by adding it.
import { createClient } from 'redis';
import { logger } from './logger.mjs';

const REDIS_URL = process.env.REDIS_URL;

let client = null;
let connectPromise = null;

export function isRedisConfigured() {
  return Boolean(REDIS_URL);
}

/** Returns a connected client, or null if unconfigured / not currently connected. */
export async function getRedisClient() {
  if (!REDIS_URL) return null;
  if (client?.isReady) return client;

  // A client object already exists but isn't ready — it dropped mid-session
  // (network blip, Redis restart). node-redis retries in the background on
  // its own; returning null here lets callers fall back to in-memory for
  // now without piling on new connection attempts. Once node-redis
  // reconnects, `client.isReady` flips back to true and the check above
  // starts returning it again automatically.
  if (client) return null;

  if (!connectPromise) {
    // disableOfflineQueue is the important part here: without it, commands
    // sent while disconnected sit in node-redis's internal queue waiting on
    // reconnection instead of failing immediately — measured this adding
    // ~10s of latency to every request during a Redis outage, since
    // rate-limit-redis's passOnStoreError only kicks in once the command
    // actually rejects. With it, failures are instant and the in-memory
    // fallback (or passOnStoreError) engages right away instead.
    const candidate = createClient({ url: REDIS_URL, disableOfflineQueue: true });
    candidate.on('error', (err) => logger.warn({ err }, 'Redis client error'));

    connectPromise = candidate
      .connect()
      .then(() => {
        client = candidate;
        logger.info('Connected to Redis');
        return client;
      })
      .catch((err) => {
        logger.warn(
          { err },
          'Redis connection failed — features that use it will fall back to in-memory behavior',
        );
        connectPromise = null;
        return null;
      });
  }

  return connectPromise;
}

/**
 * Synchronous variant for call sites that run after startup has already
 * attempted the connection (see index.mjs) — returns the client if it's
 * ready, or null without waiting. Used to decide, once, whether a given
 * feature should use its Redis-backed or in-memory implementation.
 */
export function getRedisClientSync() {
  return client?.isReady ? client : null;
}
