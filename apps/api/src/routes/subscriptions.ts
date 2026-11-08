import { Router } from 'express';
import { z } from 'zod';
import { auditorAgent } from '../agents/auditor.js';
import { subscriptionsRepo } from '../repos/subscriptions.js';
import { sendSuccess, handleRouteError, sendError, GuardianBlockedError } from '../core/errors.js';
import { getAuthReq } from '../core/auth.js';

export const subscriptionsRouter = Router();

subscriptionsRouter.get('/api/subscriptions/audit', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const audit = await auditorAgent.runAudit(authReq.userId);
    sendSuccess(res, audit, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const CancelPreviewSchema = z.object({
  subscriptionIds: z.array(z.string().min(1)).min(1)
});

subscriptionsRouter.post('/api/subscriptions/cancel/preview', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const { subscriptionIds } = CancelPreviewSchema.parse(req.body);
    const result = await auditorAgent.stageCancellation(authReq.userId, subscriptionIds, authReq.requestId);

    if (!result.approval) {
      throw new GuardianBlockedError(`Cancellation blocked by Guardian: ${result.blockedReason}`);
    }

    sendSuccess(
      res,
      {
        approvalId: result.approval.id,
        preview: result.approval.preview,
        yearlySavingMinor: result.yearlySavingMinor,
        expiresAt: result.approval.expires_at
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

subscriptionsRouter.post('/api/subscriptions/:id/snooze', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const id = req.params['id'] as string;
    const sub = await subscriptionsRepo.getById(id);
    if (!sub || sub.user_id !== authReq.userId) {
      sendError(res, 'NOT_FOUND', 'Subscription not found.', 404, undefined, authReq.requestId);
      return;
    }
    const snoozeUntil = new Date(Date.now() + 90 * 86400000); // 90 days
    const updated = await subscriptionsRepo.snoozeGhost(id, snoozeUntil);
    sendSuccess(res, { subscription: updated }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

