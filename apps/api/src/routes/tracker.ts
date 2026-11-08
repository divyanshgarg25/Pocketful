import { Router } from 'express';
import { z } from 'zod';
import { trackerAgent } from '../agents/tracker.js';
import { transactionsRepo } from '../repos/transactions.js';
import { learnerAgent, type EventType } from '../agents/learner.js';
import { moneyService } from '../services/money.js';
import { sendSuccess, handleRouteError, sendError } from '../core/errors.js';
import { getAuthReq } from '../core/auth.js';
import { profilesRepo } from '../repos/profiles.js';
import { config } from '../core/config.js';
import crypto from 'crypto';

export const trackerRouter = Router();

trackerRouter.get('/api/tracker/timeline', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const txns = await transactionsRepo.getByUserId(authReq.userId);
    // Spend screen only tracks leisure visits; essential bills live on the Ledger
    const leisureTxns = txns.filter((t) => t.kind === 'leisure');
    const timeline = leisureTxns.map((t) => ({
      ...t,
      amountFormatted: moneyService.format(t.amount_minor, t.currency),
      label:
        t.match_type === 'followed'
          ? 'Followed Pip'
          : t.match_type === 'organic'
          ? 'Organic'
          : 'Manual'
    }));

    sendSuccess(res, { timeline }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

trackerRouter.post('/api/tracker/sync', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const profile = await profilesRepo.getById(authReq.userId);
    if (profile && !profile.opt_in_tracking) {
      sendSuccess(
        res,
        {
          syncedCount: 0,
          newTxnCreated: false,
          matchedCount: 0,
          optedOut: true,
          message: 'Automated leisure tracking is disabled in profile settings.',
          transactions: []
        },
        authReq.requestId
      );
      return;
    }

    // If no transactions exist, seed a realistic organic leisure spend for demo
    const existing = await transactionsRepo.getByUserId(authReq.userId);
    let newTxnCreated = false;

    if (existing.length === 0 && config.AUTH_ALLOW_DEMO === true) {
      const demoTxn = {
        id: crypto.randomUUID(),
        user_id: authReq.userId,
        source: 'paypal_sandbox' as const,
        source_ref: `txn_demo_${Date.now()}`,
        occurred_at: new Date(Date.now() - 3600000).toISOString(),
        amount_minor: 5000, // $50.00
        currency: 'USD',
        merchant_raw: 'Quiet Leaf Cafe Roastery',
        merchant_norm: 'quiet leaf cafe',
        kind: 'leisure' as const,
        category: 'cafes',
        venue_id: 'e0a1b2c3-0001-4000-8000-000000000001',
        linked_suggestion_id: null,
        match_type: null,
        confidence: null,
        needs_question: false,
        user_rating: null,
        excluded: false
      };
      await transactionsRepo.insert(demoTxn);
      newTxnCreated = true;
    }

    // Run matching on unprocessed transactions
    const txns = await transactionsRepo.getByUserId(authReq.userId);
    const needsMatch = txns.filter((t) => !t.match_type);

    const matchedList = [];
    for (const t of needsMatch) {
      const m = await trackerAgent.matchTransaction(t, authReq.userId);
      matchedList.push(m);
    }

    sendSuccess(
      res,
      {
        syncedCount: txns.length,
        newTxnCreated,
        matchedCount: matchedList.length,
        transactions: txns
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const RatingSchema = z.object({
  rating: z.enum(['worth_it', 'okay', 'too_much'])
});

trackerRouter.post('/api/tracker/:id/rating', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const id = req.params['id'] as string;
    const { rating } = RatingSchema.parse(req.body);

    const txn = await transactionsRepo.getById(id, authReq.userId);
    if (!txn || txn.user_id !== authReq.userId) {
      sendError(res, 'NOT_FOUND', 'Transaction not found.', 404);
      return;
    }

    const category = txn.category ?? 'cafes';
    const user = await profilesRepo.getById(authReq.userId);
    const funMoney = user?.guilt_free_cap_minor ?? 0;
    const priceBand = learnerAgent.classifyPriceBand(txn.amount_minor, funMoney);
    const features: Record<string, string> = {
      category,
      price_band: priceBand
    };

    // Idempotent: if rating is identical, return without duplicate learning events
    if (txn.user_rating === rating) {
      sendSuccess(res, { transaction: txn, ratingRecorded: rating, duplicate: true }, authReq.requestId);
      return;
    }

    const ratingToEventType = (r: 'worth_it' | 'okay' | 'too_much'): EventType => {
      if (r === 'worth_it') return 'organic_worth_it';
      if (r === 'okay') return 'organic_okay';
      return 'organic_too_much';
    };

    // Revert prior rating if one was already recorded
    if (txn.user_rating) {
      const prevEventType = ratingToEventType(txn.user_rating);
      await learnerAgent.revertEvent(authReq.userId, features, prevEventType);
    }

    const updated = await transactionsRepo.updateRating(id, rating, authReq.userId);
    const newEventType = ratingToEventType(rating);
    await learnerAgent.applyEvent(authReq.userId, features, newEventType);

    sendSuccess(res, { transaction: updated, ratingRecorded: rating }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const ManualVisitSchema = z.object({
  merchantName: z.string().min(1),
  amountMinor: z.number().int().positive(),
  category: z.string().default('cafes')
});

trackerRouter.post('/api/tracker/manual', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const input = ManualVisitSchema.parse(req.body);
    const user = await profilesRepo.getById(authReq.userId);
    const currency = user?.currency ?? 'USD';
    const txn = {
      id: crypto.randomUUID(),
      user_id: authReq.userId,
      source: 'manual' as const,
      source_ref: `manual_${Date.now()}`,
      occurred_at: new Date().toISOString(),
      amount_minor: input.amountMinor,
      currency,
      merchant_raw: input.merchantName,
      merchant_norm: trackerAgent.normalizeMerchant(input.merchantName),
      kind: 'leisure' as const,
      category: input.category,
      venue_id: null,
      linked_suggestion_id: null,
      match_type: 'organic' as const,
      confidence: 1.0,
      needs_question: false,
      user_rating: null,
      excluded: false
    };

    const inserted = await transactionsRepo.insert(txn);
    await learnerAgent.applyEvent(authReq.userId, { category: input.category }, 'organic');

    sendSuccess(res, { transaction: inserted }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
