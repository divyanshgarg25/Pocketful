import { Router } from 'express';
import { isRemoteSupabaseEnabled, supabaseClient, localDb } from '../core/database.js';
import { logger } from '../core/logger.js';

export const healthzRouter = Router();

// Public liveness probe - strictly returns status: ok without leaking internal state
healthzRouter.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Internal/Readiness probe - checks database connectivity and returns 503 on failure
healthzRouter.get('/readyz', async (_req, res) => {
  try {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient.from('profiles').select('id').limit(1);
      if (error) {
        logger.error('[Health] Readyz database connectivity check failed', error);
        return res.status(503).json({ status: 'unavailable', error: 'Database query failed' });
      }
    } else {
      if (!localDb || !localDb.profiles) {
        return res.status(503).json({ status: 'unavailable', error: 'Local database state uninitialized' });
      }
    }

    return res.status(200).json({ status: 'ready' });
  } catch (err) {
    logger.error('[Health] Readyz unexpected exception', err);
    return res.status(503).json({ status: 'unavailable', error: 'Service unavailable' });
  }
});
