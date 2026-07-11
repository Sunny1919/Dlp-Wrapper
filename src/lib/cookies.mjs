// © Author: aliyie
// https://discord.gg/aerox

// Cookie file management for sites that require an authenticated session
// (YouTube being the main one). This does NOT log into anything on your
// behalf — you still export cookies from a real logged-in browser yourself.
// What "automatic" covers here:
//
//   1. Copies YTDLP_COOKIES_FILE into a writable temp path at startup and
//      hands *that* path to yt-dlp. yt-dlp reads AND rewrites the cookie
//      jar after every run as session tokens rotate — but hosting
//      platforms often mount secret files read-only (e.g. Render Secret
//      Files), which silently breaks that rewrite. Working from a writable
//      copy keeps yt-dlp's own refresh behavior intact.
//   2. Re-syncs from the source file on an interval, so dropping in a
//      freshly exported cookies file at the same path is picked up without
//      restarting the service.
//   3. Parses the Netscape cookie file's expiry timestamps and logs a
//      warning when entries are expired or expiring soon, so you know to
//      re-export before requests start failing.
import { copyFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from './logger.mjs';

const SOURCE_FILE = process.env.YTDLP_COOKIES_FILE;
const WRITABLE_PATH = path.join(tmpdir(), 'dlp-wrapper-cookies.txt');
const SYNC_INTERVAL_MS = Number(process.env.COOKIE_SYNC_INTERVAL_MS ?? 5 * 60_000);
const EXPIRY_WARNING_WINDOW_MS = Number(process.env.COOKIE_EXPIRY_WARNING_MS ?? 24 * 60 * 60_000);

let lastSourceMtimeMs = 0;
let hasWritableCopy = false;

/** Warns about expired or soon-to-expire entries in a Netscape cookies.txt. */
async function checkExpiry() {
  let content;
  try {
    content = await readFile(WRITABLE_PATH, 'utf-8');
  } catch {
    return;
  }

  const now = Date.now();
  const soonThreshold = now + EXPIRY_WARNING_WINDOW_MS;
  let expired = 0;
  let expiringSoon = 0;

  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const expirySeconds = Number(cols[4]);
    if (!expirySeconds) continue; // session cookie — no fixed expiry to check
    const expiryMs = expirySeconds * 1000;
    if (expiryMs < now) expired += 1;
    else if (expiryMs < soonThreshold) expiringSoon += 1;
  }

  if (expired > 0) {
    logger.warn({ expired }, 'Cookie file has expired entries — re-export cookies from a logged-in browser');
  } else if (expiringSoon > 0) {
    logger.warn({ expiringSoon }, 'Cookie file has entries expiring within 24h — consider re-exporting soon');
  }
}

async function syncOnce() {
  if (!SOURCE_FILE) return;
  try {
    const info = await stat(SOURCE_FILE);
    if (info.mtimeMs === lastSourceMtimeMs) return; // unchanged since last sync
    await copyFile(SOURCE_FILE, WRITABLE_PATH);
    lastSourceMtimeMs = info.mtimeMs;
    hasWritableCopy = true;
    logger.info({ source: SOURCE_FILE }, 'Cookie file synced to writable working copy');
    await checkExpiry();
  } catch (err) {
    logger.warn({ err, source: SOURCE_FILE }, 'Failed to sync cookies file');
  }
}

/** Path to pass to yt-dlp's --cookies flag, or null if none is configured. */
export function activeCookiesPath() {
  return hasWritableCopy ? WRITABLE_PATH : null;
}

/** Starts the initial sync + periodic re-sync. No-op if YTDLP_COOKIES_FILE is unset. */
export async function startCookieManager() {
  if (!SOURCE_FILE) return;
  await syncOnce();
  setInterval(() => {
    syncOnce().catch((err) => logger.warn({ err }, 'Cookie sync failed'));
  }, SYNC_INTERVAL_MS).unref();
}
