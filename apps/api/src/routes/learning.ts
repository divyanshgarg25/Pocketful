import { Router } from 'express';
import { z } from 'zod';
import { learnerAgent } from '../agents/learner.js';
import { guardianAgent } from '../agents/guardian.js';
import { banditRepo } from '../repos/bandit.js';
import { transactionsRepo } from '../repos/transactions.js';
import { profilesRepo } from '../repos/profiles.js';
import { sendSuccess, sendError, handleRouteError, NotFoundError } from '../core/errors.js';
import type { AuthenticatedRequest } from '../core/auth.js';

export const learningRouter = Router();

learningRouter.get('/api/learning/profile', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const lines = await learnerAgent.getLearnedLines(authReq.userId);
    const user = await profilesRepo.getById(authReq.userId);

    const banditStates = await banditRepo.getBanditStateForUser(authReq.userId);
    const txns = await transactionsRepo.getByUserId(authReq.userId);

    const categoryCounts = new Map<string, { count: number; firstDate: Date; label: string }>();
    for (const t of txns) {
      if (t.kind === 'leisure' && t.category && !t.excluded) {
        const cat = t.category.toLowerCase();
        const cur = categoryCounts.get(cat) ?? {
          count: 0,
          firstDate: new Date(t.occurred_at),
          label: t.merchant_raw || (cat.charAt(0).toUpperCase() + cat.slice(1))
        };
        cur.count++;
        const d = new Date(t.occurred_at);
        if (d < cur.firstDate) cur.firstDate = d;
        categoryCounts.set(cat, cur);
      }
    }

    for (const [, bState] of banditStates.entries()) {
      if (bState.feature === 'category' && bState.alpha > bState.beta) {
        const cat = bState.value.toLowerCase();
        if (!categoryCounts.has(cat)) {
          categoryCounts.set(cat, {
            count: Math.round(bState.alpha),
            firstDate: new Date(bState.updated_at ?? Date.now()),
            label: cat.charAt(0).toUpperCase() + cat.slice(1)
          });
        }
      }
    }

    const now = Date.now();
    const comfortRings = Array.from(categoryCounts.entries())
      .filter(([_, info]) => info.count >= 1)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([cat, info]) => {
        const monthsAgo = Math.max(0, Math.floor((now - info.firstDate.getTime()) / (30 * 86400000)));
        const monthAdded = monthsAgo === 0 ? 'This month' : `Month ${monthsAgo + 1}`;
        return {
          category: cat,
          monthAdded,
          label: info.label
        };
      });

    const data = {
      lines,
      explorationLevel: user?.exploration_level ?? 'normal',
      comfortRings
    };

    sendSuccess(res, data, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const ForgetSchema = z.object({
  feature: z.string(),
  value: z.string().optional()
});

learningRouter.post('/api/learning/forget', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { feature, value } = ForgetSchema.parse(req.body);
    await banditRepo.revertEventsForFeature(authReq.userId, feature, value);
    await learnerAgent.recomputeBanditState(authReq.userId);
    sendSuccess(res, { reverted: true, message: `Forgot learned preferences for ${feature}.` }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

learningRouter.post('/api/learning/reset', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const user = await profilesRepo.getById(authReq.userId);
    if (!user) throw new NotFoundError('User profile not found.');

    const { approval, blockedReason } = await guardianAgent.requestApproval(
      user,
      {
        type: 'reset_learning',
        amountMinor: 0,
        payload: { reset: true },
        preview: 'Reset all learned lifestyle preferences back to baseline priors.',
        idempotencyKey: `reset_learning_${authReq.userId}`
      },
      authReq.requestId
    );

    if (blockedReason || !approval) {
      sendError(res, 'GUARDIAN_BLOCKED', blockedReason ?? 'Reset blocked by safety policy.', 403);
      return;
    }

    sendSuccess(
      res,
      {
        status: 'pending',
        requiresApproval: true,
        approval,
        message: 'Guardian approval staged. Step-up authorization required to reset learning state.'
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
