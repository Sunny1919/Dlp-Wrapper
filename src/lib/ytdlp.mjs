// © Author: aliyie
// https://discord.gg/aerox

// Thin wrapper around the yt-dlp CLI (shelling out since it has 1,750+
// extractors and updates daily — no realistic way to keep up otherwise).
import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from './logger.mjs';
import { activeCookiesPath } from './cookies.mjs';

const YTDLP_BIN = process.env.YTDLP_BIN ?? 'yt-dlp';

/** Prefix used for every per-request temp dir created in routes/media.mjs. */
export const TEMP_DIR_PREFIX = 'ytdlp-';

/** Append --cookies <path> if a managed cookies file is active (see cookies.mjs). */
export function cookieArgs() {
  const cookiesFile = activeCookiesPath();
  return cookiesFile ? ['--cookies', cookiesFile] : [];
}

export class YtDlpError extends Error {
  constructor(message, stderr) {
    super(message);
    this.name = 'YtDlpError';
    this.stderr = stderr;
  }
}

/**
 * Verify the configured binary actually runs. Called once at startup so a
 * bad YTDLP_BIN shows up in logs immediately instead of silently 422-ing
 * every request while /api/healthz keeps reporting healthy.
 */
export function checkYtDlpBinary() {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('error', (err) => reject(new YtDlpError(`yt-dlp binary check failed: ${err.message}`, '')));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new YtDlpError(`yt-dlp --version exited with code ${code}`, ''));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Remove leftover per-request temp dirs older than maxAgeMs. Each request
 * cleans up its own dir on close/error, but a crash or SIGKILL mid-request
 * can leave one behind; this is the safety net against that.
 */
export async function sweepStaleTempDirs(maxAgeMs) {
  const base = tmpdir();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err }, 'Temp dir sweep: failed to list tmpdir');
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) continue;
    const fullPath = path.join(base, entry.name);
    try {
      const info = await stat(fullPath);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(fullPath, { recursive: true, force: true });
        logger.info({ dir: fullPath }, 'Temp dir sweep: removed stale download dir');
      }
    } catch (err) {
      logger.warn({ err, dir: fullPath }, 'Temp dir sweep: failed to inspect/remove dir');
    }
  }
}

/** Run yt-dlp once, collecting stdout + stderr. SIGKILLs after timeoutMs. */
function runYtDlp(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks = [];
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new YtDlpError(`Failed to launch yt-dlp: ${err.message}`, stderr));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new YtDlpError('yt-dlp timed out', stderr));
        return;
      }
      if (code !== 0) {
        reject(new YtDlpError(`yt-dlp exited with code ${code}`, stderr));
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}

// yt-dlp's `-J` dump has hundreds of fields — we only declare what we read.
const RAW_FORMAT_KEYS = [
  'format_id',
  'ext',
  'resolution',
  'format_note',
  'filesize',
  'filesize_approx',
  'vcodec',
  'acodec',
];

const RAW_INFO_KEYS = [
  'id',
  'title',
  'description',
  'thumbnail',
  'duration',
  'uploader',
  'webpage_url',
  'extractor',
  'formats',
  'url',
  'requested_formats',
  'requested_downloads',
];

function pickKeys(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

export function toMediaFormat(raw) {
  const vcodec = raw.vcodec ?? null;
  const acodec = raw.acodec ?? null;
  const isNone = (c) => !c || c === 'none';
  return {
    formatId: raw.format_id,
    ext: raw.ext,
    resolution: raw.resolution ?? null,
    note: raw.format_note ?? null,
    filesizeApprox: raw.filesize ?? raw.filesize_approx ?? null,
    vcodec,
    acodec,
    hasVideo: !isNone(vcodec),
    hasAudio: !isNone(acodec),
  };
}

/** Full metadata for `url`: title, thumbnail, duration, uploader, all formats. */
export async function fetchMediaInfo(url) {
  const { stdout } = await runYtDlp([
    '-J',
    '--no-warnings',
    '--no-playlist',
    ...cookieArgs(),
    url,
  ]);

  const stdoutStr = stdout.toString('utf-8');
  let raw;
  try {
    raw = JSON.parse(stdoutStr);
  } catch {
    throw new YtDlpError('yt-dlp returned non-JSON output for info request', stdoutStr.slice(0, 500));
  }

  const picked = pickKeys(raw, RAW_INFO_KEYS);
  return {
    id: picked.id,
    title: picked.title,
    description: picked.description ?? null,
    thumbnail: picked.thumbnail ?? null,
    durationSeconds: picked.duration ?? null,
    uploader: picked.uploader ?? null,
    webpageUrl: picked.webpage_url ?? null,
    extractor: picked.extractor ?? null,
    formats: (picked.formats ?? []).map(toMediaFormat),
  };
}

/**
 * Resolve the underlying CDN URL(s) without routing bytes through this
 * server. yt-dlp puts the URL in a different place depending on the format
 * selector — single ("best") vs combined ("bestvideo+bestaudio") — so we
 * check all the possible locations.
 */
export async function resolveDirectUrls(url, format) {
  const { stdout } = await runYtDlp([
    '-J',
    '-f',
    format,
    '--no-warnings',
    '--no-playlist',
    ...cookieArgs(),
    url,
  ]);

  const stdoutStr = stdout.toString('utf-8');
  let raw;
  try {
    raw = JSON.parse(stdoutStr);
  } catch {
    throw new YtDlpError(
      'yt-dlp returned non-JSON output for direct-url request',
      stdoutStr.slice(0, 500),
    );
  }

  const extractUrls = (entries) =>
    (entries ?? [])
      .map((d) => d.url)
      .filter((u) => typeof u === 'string' && u.length > 0);

  const urls = raw.requested_formats?.length
    ? extractUrls(raw.requested_formats)
    : raw.requested_downloads?.length
      ? extractUrls(raw.requested_downloads)
      : raw.url
        ? [raw.url]
        : [];

  if (urls.length === 0) {
    throw new YtDlpError('No streamable URL found for the requested format', '');
  }

  return { title: raw.title ?? null, urls };
}

/** Default download budget. Override via YTDLP_DOWNLOAD_TIMEOUT_MS (ms). */
const DOWNLOAD_TIMEOUT_MS = Number(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS ?? 10 * 60_000);

/**
 * Fork yt-dlp for a real download; caller pipes the returned child's stdout
 * to the HTTP response. We resume stdout immediately so the OS pipe buffer
 * never fills and blocks yt-dlp's write() mid-download.
 */
export function spawnDownload(args) {
  // Last arg is always the source URL (may contain tokens) — never log it.
  const loggableArgs = args.slice(0, -1).join(' ');
  logger.info({ args: loggableArgs }, 'Spawning yt-dlp download process');
  const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.resume();

  const timer = setTimeout(() => {
    logger.warn({ timeoutMs: DOWNLOAD_TIMEOUT_MS }, 'Killing yt-dlp download: exceeded max duration');
    child.kill('SIGKILL');
  }, DOWNLOAD_TIMEOUT_MS);
  child.on('close', () => clearTimeout(timer));

  return child;
}
