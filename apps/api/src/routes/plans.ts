import { Router } from 'express';
import { z } from 'zod';
import { plannerAgent } from '../agents/planner.js';
import { suggestionsRepo } from '../repos/suggestions.js';
import { learnerAgent } from '../agents/learner.js';
import { sendSuccess, handleRouteError, sendError } from '../core/errors.js';
import { getAuthReq } from '../core/auth.js';

export const plansRouter = Router();

const PlanRequestSchema = z.object({
  mood: z.enum(['drained', 'okay', 'great']).optional(),
  groupSize: z.number().int().min(1).max(20).optional(),
  radiusKm: z.number().min(1).max(50).optional(),
  occasionType: z.enum(['everyday', 'weekend', 'holiday', 'getaway']).optional()
});

plansRouter.post('/api/plans', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const input = PlanRequestSchema.parse(req.body);
    const result = await plannerAgent.generatePlan(authReq.userId, {
      ...input,
      requestId: authReq.requestId
    });

    sendSuccess(res, result, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const FeedbackSchema = z.object({
  outcome: z.enum(['accepted', 'modified', 'rejected', 'ignored']),
  rejectReason: z.enum(['too_far', 'too_pricey', 'not_my_vibe', 'did_recently']).optional()
});

plansRouter.post('/api/suggestions/:id/feedback', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const id = req.params['id'] as string;
    const { outcome, rejectReason } = FeedbackSchema.parse(req.body);

    const suggestion = await suggestionsRepo.getById(id);
    if (!suggestion || suggestion.user_id !== authReq.userId) {
      sendError(res, 'NOT_FOUND', 'Suggestion not found.', 404);
      return;
    }

    const updated = await suggestionsRepo.updateOutcome(id, outcome, rejectReason);

    let learnedLine = '';
    if (outcome === 'rejected' && rejectReason) {
      await learnerAgent.applyRejection(authReq.userId, suggestion.features as Record<string, string>, rejectReason);
      if (rejectReason === 'too_far') learnedLine = 'Learned: Moving closer places up in ranking.';
      else if (rejectReason === 'too_pricey') learnedLine = 'Learned: Prioritizing lower price bands.';
      else if (rejectReason === 'not_my_vibe') learnedLine = 'Learned: Reducing frequency of this vibe.';
      else learnedLine = 'Learned: Snoozing recently visited categories.';
    } else if (outcome === 'accepted') {
      await learnerAgent.applyEvent(authReq.userId, suggestion.features as Record<string, string>, 'followed');
      learnedLine = 'Learned: Great match! Added to your comfort profile.';
    }

    sendSuccess(res, { suggestion: updated, learnedLine }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
