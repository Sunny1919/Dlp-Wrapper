// © Author: aliyie
// https://discord.gg/aerox

// Entry point.
import { logger } from './lib/logger.mjs';
import { checkYtDlpBinary, sweepStaleTempDirs } from './lib/ytdlp.mjs';
import { getRedisClient, isRedisConfigured } from './lib/redis.mjs';
import { startCookieManager } from './lib/cookies.mjs';

const rawPort = process.env.PORT ?? '8080';
const port = Number(rawPort);

if (Number.isNaN(port) || port < 0 || !Number.isInteger(port)) {
  logger.error({ port: rawPort }, 'Invalid PORT value — must be a non-negative integer');
  process.exit(1);
}

// Verify yt-dlp actually runs before accepting traffic — a bad YTDLP_BIN
// would otherwise pass /api/healthz while every real request silently 422s.
try {
  const version = await checkYtDlpBinary();
  logger.info({ version }, 'yt-dlp binary check passed');
} catch (err) {
  logger.error({ err }, 'yt-dlp binary check failed — media endpoints will not work');
}

await startCookieManager();

// Attempt the Redis connection here, before app.mjs (and the route modules
// it pulls in) are evaluated — app.mjs and media.mjs each decide, once, at
// module-load time whether to use a Redis-backed store/cache or the
// in-memory fallback. A dynamic import defers that evaluation until after
// this resolves, so the decision reflects whether Redis is actually up.
if (isRedisConfigured()) {
  await getRedisClient();
}
const { default: app } = await import('./app.mjs');

const server = app.listen(port, () => {
  const actualPort = server.address().port;
  logger.info({ port: actualPort, requestedPort: port }, 'Dlp Wrapper listening');
});

// Sweep leftover temp dirs from crashed/killed requests so ephemeral disk
// doesn't slowly fill up. Anything younger than the download timeout is
// assumed to be an in-flight request and left alone.
const SWEEP_INTERVAL_MS = Number(process.env.TEMP_SWEEP_INTERVAL_MS ?? 30 * 60_000);
const TEMP_MAX_AGE_MS = Number(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS ?? 10 * 60_000) + 5 * 60_000;
const sweepTimer = setInterval(() => {
  sweepStaleTempDirs(TEMP_MAX_AGE_MS).catch((err) => {
    logger.warn({ err }, 'Temp dir sweep failed');
  });
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

// listen() never calls back with an error; bind failures land on 'error'.
server.on('error', (err) => {
  logger.error({ err }, 'Error listening on port');
  process.exit(1);
});

// Graceful shutdown — drain in-flight requests on SIGTERM/SIGINT.
const shutdown = (signal) => {
  logger.info({ signal }, 'Received signal — closing server');
  server.close(() => {
    logger.info('Server closed cleanly');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('Forcing shutdown after 10s grace period');
    process.exit(1);
  }, 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
