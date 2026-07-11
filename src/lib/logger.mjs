// © Author: aliyie
// https://discord.gg/aerox

// Lightweight Pino logger.
//   - NODE_ENV=production → plain structured JSON logs (cheap, log-friendly)
//   - otherwise            → colourised output via pino-pretty for dev
import { pino } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
  ],
  base: { service: 'dlp-wrapper' },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }),
});
