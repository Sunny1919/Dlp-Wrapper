<!--
  © Author: aliyie
  https://discord.gg/aerox
-->

<div align="center">

# Dlp Wrapper

**Made by Ayle**

[![Join Discord](https://img.shields.io/badge/Discord-Join%20AeroX%20Development-5865F2?logo=discord&logoColor=white)](https://discord.gg/aerox)
[![Online](https://img.shields.io/discord/YOUR_SERVER_ID?label=online&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/aerox)

</div>

> The "online" badge needs your server's numeric ID, not the invite code — enable it under **Server Settings → Widget → Enable Server Widget**, copy the **Server ID** shown there, and replace `YOUR_SERVER_ID` above with it.

---

## Tech stack

| Layer | Used for |
|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Core extraction logic — every metadata/URL/download operation shells out to it |
| ffmpeg | Muxing video+audio and audio extraction (MP3) |
| Node.js 20+ / Express | HTTP API |
| Redis (optional) | Distributed rate limiting, shared metadata cache, per-IP quotas |
| Prometheus (`prom-client`) | Metrics at `/metrics` |
| Docker | Packaging — bundles yt-dlp + ffmpeg with the app |
| Render | Recommended host (Blueprint included) |

---

## What this is

A self-hosted REST API wrapping yt-dlp. Fetch metadata, resolve direct CDN URLs, or download MP4/MP3 from 1,750+ sites — drop it into a web app or a Discord bot over plain HTTP. You host it yourself; it is not a public service.

Once deployed, visiting the base URL in a browser serves a full built-in documentation page (`src/public/docs.html`) with every endpoint, parameter, example, and environment variable.

## Features

- Metadata, direct-URL resolution, and MP4/MP3 download endpoints
- SSRF-guarded URL input, constant-time API key check, closed-by-default CORS
- Rate limiting and concurrency caps, with optional request queuing instead of immediate rejection
- Optional Redis backing for the rate limiter, metadata cache, and per-IP quotas — falls back to in-memory if unset
- Per-IP daily quotas, separate from short-window rate limits
- Prometheus metrics at `/metrics`
- Managed cookie handling for authenticated sites (YouTube), including expiry warnings

## Quick start (local)

```bash
git clone https://github.com/ayliee/Dlp-Wrapper.git
cd Dlp-Wrapper
npm install
cp .env.example .env    # set API_KEY at minimum before exposing this anywhere
npm start
# → listening on http://localhost:8080
```

Requires Node.js 20+, plus `yt-dlp` and `ffmpeg` on `PATH` (both are already bundled if you run it via Docker instead — see below).

---

## Deploy — Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ayliee/Dlp-Wrapper)

Clicking that takes you straight to Render with this repo pre-filled — it reads `render.yaml` and provisions the service, generating `API_KEY` for you.

1. Click the button above (or **New → Blueprint** on [render.com](https://render.com) and connect this repo yourself)
2. Set `ALLOWED_ORIGINS` if a web app will call the API directly from browser JS
3. Deploy — your base URL is `https://<service-name>.onrender.com`

`render.yaml` must sit at the root of the repo Render reads from for the button/Blueprint to find it — if you've nested this project under a subfolder in your own repo, move `render.yaml` (and the rest of this project) up to the root first.

Optional: uncomment the `keyvalue` block in `render.yaml` to add a managed Redis-compatible instance for the shared cache/rate-limit/quota features.

## Deploy — VPS

No Docker required if you'd rather run it directly:

```bash
# 1. System dependencies
sudo apt update && sudo apt install -y python3 python3-pip ffmpeg curl

# 2. Node.js 22.x — Ubuntu's default apt repo only ships Node 18, which is
# below this project's Node >=20 requirement, so pull from NodeSource instead.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. yt-dlp
pip3 install --break-system-packages -U yt-dlp

# 4. This project
git clone https://github.com/ayliee/Dlp-Wrapper.git
cd Dlp-Wrapper
npm install
cp .env.example .env   # edit: set API_KEY, ALLOWED_ORIGINS, etc.

# 5. Run it under a process manager so it survives reboots/crashes
npm install -g pm2
pm2 start src/index.mjs --name dlp-wrapper
pm2 save && pm2 startup
```

Put a reverse proxy (nginx, Caddy) in front of it for TLS. A minimal nginx config:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Prefer Docker instead? The included `Dockerfile` bundles yt-dlp + ffmpeg so you don't manage those separately:

```bash
docker build -t dlp-wrapper .
docker run -d --restart unless-stopped -p 8080:8080 \
  -e PORT=8080 -e API_KEY=your-secret-key \
  --name dlp-wrapper dlp-wrapper
```

---

## Project structure

```
dlp-wrapper/
├── src/
│   ├── index.mjs              # Entry point — startup checks, Redis connect, graceful shutdown
│   ├── app.mjs                 # Express app: middleware, rate limiting, /metrics, docs route
│   ├── lib/
│   │   ├── ytdlp.mjs            # yt-dlp CLI wrapper — info/direct-url/download
│   │   ├── security.mjs         # SSRF guard, constant-time key check, concurrency semaphore
│   │   ├── cache.mjs            # Metadata cache (Redis or in-memory TTL)
│   │   ├── quota.mjs            # Per-IP quota counters (Redis or in-memory)
│   │   ├── redis.mjs            # Shared optional Redis client
│   │   ├── rateLimitStore.mjs   # Redis-or-memory store for express-rate-limit
│   │   ├── metrics.mjs          # Prometheus metrics (prom-client)
│   │   ├── cookies.mjs          # Cookie file sync, refresh, expiry warnings
│   │   └── logger.mjs           # Pino logger
│   ├── routes/
│   │   ├── index.mjs            # Route mounting
│   │   ├── health.mjs           # GET /healthz
│   │   └── media.mjs            # GET /media/info, /media/direct-url, /media/download
│   └── public/
│       └── docs.html            # Built-in documentation page, served at GET /
├── examples/
│   ├── discord-bot/             # Minimal discord.js integration
│   └── web-app/                 # Minimal browser demo
├── scripts/
│   └── smoke-test.mjs           # End-to-end check against a running instance
├── Dockerfile
├── render.yaml                  # Render Blueprint
└── .env.example
```

## API reference

The full reference — every endpoint, parameter, response shape, and environment variable — lives in the built-in docs page, served at your deployed base URL (`/`), or open `src/public/docs.html` directly.

Endpoints at a glance:

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness check |
| GET | `/media/info` | Metadata: title, thumbnail, duration, formats |
| GET | `/media/direct-url` | Resolve the underlying CDN URL, no bytes proxied |
| GET | `/media/download` | Download as MP4/MP3, streamed back |
| GET | `/metrics` | Prometheus metrics |

## License

MIT.
