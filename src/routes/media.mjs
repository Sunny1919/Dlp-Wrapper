// © Author: aliyie
// https://discord.gg/aerox

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cookieArgs,
  fetchMediaInfo,
  resolveDirectUrls,
  spawnDownload,
  TEMP_DIR_PREFIX,
  YtDlpError,
} from '../lib/ytdlp.mjs';
import { assertPublicHttpUrl, safeEqual, Semaphore, SsrfError } from '../lib/security.mjs';
import { buildRateLimitStore } from '../lib/rateLimitStore.mjs';
import { cacheGet, cacheSet } from '../lib/cache.mjs';
import { incrementQuota } from '../lib/quota.mjs';
import { activeJobs, cacheEvents, quotaRejections } from '../lib/metrics.mjs';

const router = Router();

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

/**
 * When API_KEY is unset the endpoint is open (fine for local/private use,
 * not for a public deployment). Comparison is constant-time.
 */
function requireApiKey(req, res) {
  const configuredKey = process.env.API_KEY;
  if (!configuredKey) return true;

  const providedKey = req.header('x-api-key');
  if (providedKey && safeEqual(providedKey, configuredKey)) return true;

  sendError(res, 401, 'Invalid or missing API key');
  return false;
}

function parseUrlParam(req, res) {
  const url = req.query.url;
  if (typeof url !== 'string' || url.trim().length === 0) {
    sendError(res, 400, "Query parameter 'url' is required");
    return null;
  }
  return url;
}

/** Rejects (400) unless `url` is a public http(s) address — SSRF guard. */
async function assertUrlIsSafe(url, req, res) {
  try {
    await assertPublicHttpUrl(url);
    return true;
  } catch (err) {
    if (err instanceof SsrfError) {
      sendError(res, 400, err.message);
      return false;
    }
    req.log?.error({ err }, 'Unexpected error validating url');
    sendError(res, 400, 'Invalid url');
    return false;
  }
}

// yt-dlp format selectors are built from a small character set (format ids,
// +, *, /, [], (), digits, letters, :, comparison operators). No need to
// accept anything outside that before it reaches the CLI.
const SAFE_FORMAT_RE = /^[a-zA-Z0-9_\-+*/,.:<>=\[\]() ]{1,200}$/;

function parseFormatParam(req, res, fallback) {
  const raw = req.query.format;
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !SAFE_FORMAT_RE.test(raw)) {
    sendError(res, 400, "Query parameter 'format' is invalid");
    return null;
  }
  return raw;
}

// ---------------- concurrency: immediate-reject or queued ----------------

// Each yt-dlp/ffmpeg call is a real subprocess (CPU, RAM, and for downloads,
// disk). These caps stop a handful of concurrent requests from taking the
// whole service down on a small container — raise via env vars if the plan
// is sized for more.
const infoSemaphore = new Semaphore(Number(process.env.DLP_MAX_CONCURRENT_INFO ?? 8));
const downloadSemaphore = new Semaphore(Number(process.env.DLP_MAX_CONCURRENT_DOWNLOADS ?? 2));

// By default, hitting the concurrency cap returns 429 immediately. Setting
// QUEUE_ENABLED=true instead makes the request wait (bounded by
// QUEUE_MAX_WAIT_MS, with at most QUEUE_MAX_LENGTH requests waiting at
// once) for a slot to free up — trades latency for a lower rejection rate
// under bursty load.
const QUEUE_ENABLED = process.env.QUEUE_ENABLED === 'true';
const QUEUE_MAX_WAIT_MS = Number(process.env.QUEUE_MAX_WAIT_MS ?? 15_000);
const QUEUE_MAX_LENGTH = Number(process.env.QUEUE_MAX_LENGTH ?? 50);

/** Acquires a slot (immediately or via the queue); sends 429 itself on failure. */
async function acquireSlot(semaphore, kind, req, res, busyMessage) {
  const acquired = QUEUE_ENABLED
    ? await semaphore.acquireQueued(QUEUE_MAX_WAIT_MS, QUEUE_MAX_LENGTH)
    : semaphore.tryAcquire();

  if (!acquired) {
    sendError(res, 429, busyMessage);
    return false;
  }
  if (req.destroyed || res.writableEnded) {
    // Client gave up while we were queued — free the slot, don't spawn work.
    semaphore.release();
    return false;
  }
  activeJobs.inc({ kind });
  return true;
}

function releaseSlot(semaphore, kind) {
  semaphore.release();
  activeJobs.dec({ kind });
}

// ---------------- per-IP quotas (opt-in, longer window than rate limits) ----------------

const QUOTA_ENABLED = process.env.QUOTA_ENABLED === 'true';
const QUOTA_WINDOW_MS = Number(process.env.QUOTA_WINDOW_MS ?? 24 * 60 * 60_000);
const QUOTA_MAX_INFO = Number(process.env.QUOTA_MAX_INFO ?? 500);
const QUOTA_MAX_DIRECT_URL = Number(process.env.QUOTA_MAX_DIRECT_URL ?? 500);
const QUOTA_MAX_DOWNLOADS = Number(process.env.QUOTA_MAX_DOWNLOADS ?? 50);

/** Enforces the per-IP daily quota for `route`; sends 429 itself on the caller's behalf. */
async function enforceQuota(route, max, req, res) {
  if (!QUOTA_ENABLED) return true;
  const { limited, resetAt } = await incrementQuota(`${route}:${req.ip}`, QUOTA_WINDOW_MS, max);
  if (!limited) return true;

  quotaRejections.inc({ route });
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
  sendError(res, 429, `Daily quota exceeded for this endpoint — resets ${new Date(resetAt).toISOString()}`);
  return false;
}

// ---------------- metadata cache (opt-in speedup, Redis or in-memory) ----------------

const CACHE_TTL_INFO_MS = Number(process.env.CACHE_TTL_INFO_MS ?? 5 * 60_000);
const CACHE_TTL_DIRECT_URL_MS = Number(process.env.CACHE_TTL_DIRECT_URL_MS ?? 2 * 60_000);

// Downloads spin up ffmpeg and can run for minutes — a stricter limit on
// top of the general one in app.mjs. Shares the same Redis store as the
// general limiter when REDIS_URL is configured.
const downloadLimiter = rateLimit({
  windowMs: Number(process.env.DOWNLOAD_RATE_LIMIT_WINDOW_MS ?? 10 * 60_000),
  limit: Number(process.env.DOWNLOAD_RATE_LIMIT_MAX ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  store: buildRateLimitStore('dlpwrapper:rl:download:'),
  message: { error: 'Too many download requests — please slow down' },
});

/** Passed to yt-dlp's own --max-filesize so oversized files never hit disk. */
const MAX_FILESIZE = process.env.YTDLP_MAX_FILESIZE;
function maxFilesizeArgs() {
  return MAX_FILESIZE ? ['--max-filesize', MAX_FILESIZE] : [];
}

/**
 * GET /api/media/info?url=<url>
 * Metadata for any yt-dlp-supported URL: title, thumbnail, duration, formats.
 * Cached for CACHE_TTL_INFO_MS since the same url is often requested repeatedly.
 */
router.get('/media/info', async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const url = parseUrlParam(req, res);
  if (!url) return;
  if (!(await assertUrlIsSafe(url, req, res))) return;
  if (!(await enforceQuota('info', QUOTA_MAX_INFO, req, res))) return;

  const cached = await cacheGet('info', [url]);
  if (cached) {
    cacheEvents.inc({ namespace: 'info', result: 'hit' });
    res.json(cached);
    return;
  }
  cacheEvents.inc({ namespace: 'info', result: 'miss' });

  if (!(await acquireSlot(infoSemaphore, 'info', req, res, 'Server is busy — please retry shortly'))) return;

  try {
    const info = await fetchMediaInfo(url);
    await cacheSet('info', [url], info, CACHE_TTL_INFO_MS);
    res.json(info);
  } catch (err) {
    req.log?.error({ err }, 'Failed to fetch media info');
    const message = err instanceof YtDlpError ? err.message : 'Failed to extract media info';
    sendError(res, 422, message);
  } finally {
    releaseSlot(infoSemaphore, 'info');
  }
});

/**
 * GET /api/media/direct-url?url=<url>&format=best
 * Resolves the underlying CDN URL(s) with no bytes routed through this
 * server — good for Discord embeds or `<video src>`. Some CDNs 403 without
 * the original request headers; fall back to /media/download if so.
 * Cached briefly — CDN URLs usually carry short-lived expiry tokens, so the
 * TTL here is intentionally shorter than /media/info's.
 */
router.get('/media/direct-url', async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const url = parseUrlParam(req, res);
  if (!url) return;
  if (!(await assertUrlIsSafe(url, req, res))) return;

  const format = parseFormatParam(req, res, 'best');
  if (format === null) return;
  if (!(await enforceQuota('direct-url', QUOTA_MAX_DIRECT_URL, req, res))) return;

  const cached = await cacheGet('direct-url', [url, format]);
  if (cached) {
    cacheEvents.inc({ namespace: 'direct-url', result: 'hit' });
    res.json(cached);
    return;
  }
  cacheEvents.inc({ namespace: 'direct-url', result: 'miss' });

  if (!(await acquireSlot(infoSemaphore, 'info', req, res, 'Server is busy — please retry shortly'))) return;

  try {
    const result = await resolveDirectUrls(url, format);
    await cacheSet('direct-url', [url, format], result, CACHE_TTL_DIRECT_URL_MS);
    res.json(result);
  } catch (err) {
    req.log?.error({ err }, 'Failed to resolve direct url');
    const message = err instanceof YtDlpError ? err.message : 'Failed to resolve direct url';
    sendError(res, 422, message);
  } finally {
    releaseSlot(infoSemaphore, 'info');
  }
});

/**
 * GET /api/media/download?url=<url>&ext=mp4|mp3&format=<selector>
 * Streams the file back as an attachment: yt-dlp downloads into a temp dir,
 * then we pipe that file to the response. Never cached — this is a stream,
 * not a storable value.
 *
 * `format` defaults to `bestvideo*+bestaudio/best` (best muxed-with-audio
 * stream, falling back to best combined stream, merged into mp4 by ffmpeg
 * when needed). Pass `format=best` to skip the merge.
 *
 * We readdir the temp dir rather than trust yt-dlp's stdout for the output
 * filename, since post-processors can leave sidecar files (.part, .description).
 */
router.get('/media/download', downloadLimiter, async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const url = parseUrlParam(req, res);
  if (!url) return;
  if (!(await assertUrlIsSafe(url, req, res))) return;

  const rawExt = req.query.ext;
  if (rawExt !== undefined && rawExt !== 'mp3' && rawExt !== 'mp4') {
    sendError(res, 400, "Query parameter 'ext' must be 'mp3' or 'mp4'");
    return;
  }
  const ext = rawExt === 'mp3' ? 'mp3' : 'mp4';

  const format = parseFormatParam(req, res, 'bestvideo*+bestaudio/best');
  if (format === null) return;
  if (!(await enforceQuota('download', QUOTA_MAX_DOWNLOADS, req, res))) return;

  if (!(await acquireSlot(downloadSemaphore, 'download', req, res, 'Too many downloads in progress — please retry shortly'))) return;

  const workDir = await mkdtemp(path.join(tmpdir(), TEMP_DIR_PREFIX));
  const outputTemplate = path.join(workDir, '%(id)s.%(ext)s');

  const args =
    ext === 'mp3'
      ? [
          '-f', 'bestaudio/best',
          '-x', '--audio-format', 'mp3',
          '--no-playlist', '--no-warnings',
          ...maxFilesizeArgs(),
          ...cookieArgs(),
          '-o', outputTemplate,
          url,
        ]
      : [
          '-f', format,
          '--merge-output-format', 'mp4',
          '--no-playlist', '--no-warnings',
          ...maxFilesizeArgs(),
          ...cookieArgs(),
          '-o', outputTemplate,
          url,
        ];

  const child = spawnDownload(args);
  let slotReleased = false;
  const releaseOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlot(downloadSemaphore, 'download');
  };

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const cleanup = () => {
    releaseOnce();
    rm(workDir, { recursive: true, force: true }).catch((err) => {
      req.log?.warn({ err, workDir }, 'Failed to clean up temp download dir');
    });
  };

  child.on('error', (err) => {
    req.log?.error({ err }, 'yt-dlp process failed to start');
    if (!res.headersSent) sendError(res, 422, 'Failed to start download');
    cleanup();
  });

  child.on('close', async (code) => {
    if (code !== 0) {
      req.log?.error({ code, stderr: stderr.slice(-1000) }, 'yt-dlp download failed');
      if (!res.headersSent) sendError(res, 422, stderr.trim().slice(-500) || 'Download failed');
      cleanup();
      return;
    }

    try {
      const files = await readdir(workDir);
      const SKIP_EXTS = new Set([
        '.part', '.ytdl', '.json', '.description', '.annotations',
        '.info.json', '.live_chat.json',
      ]);
      const mediaFiles = files.filter((f) => !SKIP_EXTS.has(path.extname(f).toLowerCase()));
      const outputFile = mediaFiles[0];
      if (!outputFile) {
        throw new Error(
          files.length > 0
            ? `Download produced no usable media file (found: ${files.join(', ')})`
            : 'Download produced no output files',
        );
      }

      const filePath = path.join(workDir, outputFile);
      const { size } = statSync(filePath);
      const contentType = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';

      res.setHeader('Content-Disposition', `attachment; filename="${outputFile}"`);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(size));

      const readStream = createReadStream(filePath);
      readStream.pipe(res);
      readStream.on('close', cleanup);
      readStream.on('error', (err) => {
        req.log?.error({ err }, 'Error streaming downloaded file');
        cleanup();
      });
    } catch (err) {
      req.log?.error({ err }, 'Failed to locate downloaded file');
      if (!res.headersSent) sendError(res, 422, 'Download produced no output');
      cleanup();
    }
  });

  // Client disconnected mid-download — kill yt-dlp to save bandwidth.
  req.on('close', () => {
    if (!res.writableEnded) child.kill('SIGKILL');
  });
});

export default router;
