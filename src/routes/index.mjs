// © Author: aliyie
// https://discord.gg/aerox

import { Router } from 'express';
import healthRouter from './health.mjs';
import mediaRouter from './media.mjs';

const router = Router();

// Mount routers. Each route is namespaced under /api by app.mjs, so paths
// here are relative to that.
router.use(healthRouter);
router.use(mediaRouter);

export default router;
