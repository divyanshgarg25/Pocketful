import { Router } from 'express';
import { auditRepo } from '../repos/audit.js';
import { sendSuccess, handleRouteError } from '../core/errors.js';
import type { AuthenticatedRequest } from '../core/auth.js';

export const auditRouter = Router();

auditRouter.get('/api/audit', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const logs = await auditRepo.getByUserId(authReq.userId);
    sendSuccess(res, { logs }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
