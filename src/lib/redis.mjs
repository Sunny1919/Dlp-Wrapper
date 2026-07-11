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

/** Returns a connected client, or null if unconfigured / connection failed. */
export async function getRedisClient() {
  if (!REDIS_URL) return null;
  if (client?.isReady) return client;

  if (!connectPromise) {
    const candidate = createClient({ url: REDIS_URL });
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
        client = null;
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
