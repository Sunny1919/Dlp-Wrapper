<!--
  © Author: aliyie
  https://discord.gg/aerox
-->

# Discord bot example

A minimal discord.js bot that uses the `Dlp Wrapper` API you just built.

## What it does

- On any message containing a URL → fetches metadata + the direct stream link, replies with a rich embed plus the direct link
- `/download <url> <mp4|mp3>` → downloads the media through the API and attaches it to the message (works for files ≤ 25 MB on free Discord)

## Setup

```bash
cd examples/discord-bot
npm install
```

Set these environment variables:

| Var | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Your bot token from the Discord developer portal |
| `DLP_WRAPPER_BASE` | ❌ | `http://localhost:8080/api` | Where your `Dlp Wrapper` instance is hosted |
| `DLP_WRAPPER_KEY` | ❌ | — | If you set `API_KEY` on the server, set the same here |

Run with:

```bash
DISCORD_TOKEN=... node bot.mjs
```

For better upload headroom, set the size guard (`SIZE_LIMIT`) in `bot.mjs` to your plan's limit.
