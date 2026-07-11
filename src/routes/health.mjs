// © Author: aliyie
// https://discord.gg/aerox

import { Router } from 'express';

const router = Router();

/** GET /api/healthz — liveness probe, suitable as a container healthcheck. */
router.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

export default router;
