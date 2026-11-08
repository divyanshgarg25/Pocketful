import { Router } from 'express';
import { z } from 'zod';
import { splitterAgent, computeEqualSplit } from '../agents/splitter.js';
import { profilesRepo } from '../repos/profiles.js';
import { settlementsRepo } from '../repos/settlements.js';
import { groupsRepo } from '../repos/groups.js';
import { suggestionsRepo } from '../repos/suggestions.js';
import { transactionsRepo } from '../repos/transactions.js';
import { approvalsRepo } from '../repos/approvals.js';
import { moneyService } from '../services/money.js';
import { sendSuccess, handleRouteError, sendError } from '../core/errors.js';
import { getAuthReq } from '../core/auth.js';

export const groupsRouter = Router();

const ContactSchema = z.string().trim().refine(
  (val) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) || /^\+[1-9]\d{1,14}$/.test(val),
  { message: 'Contact must be a valid email or E.164 phone number (e.g. +1234567890).' }
);

const CreateGroupSchema = z.object({
  suggestionId: z.string().uuid().optional(),
  transactionId: z.string().uuid().optional(),
  totalMinor: z.number().int().positive().max(10_000_000_00).optional(),
  splitMode: z.enum(['equal', 'custom']).default('equal'),
  friends: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        contact: ContactSchema,
        shareMinor: z.number().int().positive().max(10_000_000_00).optional()
      })
    )
    .min(1)
    .max(20),
  deadlineHours: z.number().int().min(1).max(168).optional()
});

const PreviewSchema = z.object({
  totalMinor: z.number().int().positive().max(10_000_000_00),
  friendCount: z.number().int().min(1).max(20)
});

/**
 * Exact equal-split amounts for a bill, computed by the same function that stages the group. The web preview shows
 * these numbers and nothing else, so it cannot drift from what friends are actually asked to pay.
 */
groupsRouter.post('/api/groups/preview', async (req, res) => {
  const authReq = getAuthReq(req);
  const parsed = PreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'totalMinor (positive integer) and friendCount (1-20) are required.', 400, undefined, authReq.requestId);
    return;
  }
  try {
    const organizer = await profilesRepo.getById(authReq.userId);
    if (!organizer) {
      sendError(res, 'NOT_FOUND', 'Profile not found.', 404, undefined, authReq.requestId);
      return;
    }
    const { totalMinor, friendCount } = parsed.data;
    const split = computeEqualSplit(authReq.userId, totalMinor, friendCount);
    sendSuccess(res, { totalMinor, currency: organizer.currency, ...split }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

groupsRouter.get('/api/groups', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const userGroups = await groupsRepo.getGroupsByOrganizer(authReq.userId);
    const enriched = await Promise.all(
      userGroups.map(async (group) => {
        const payments = await groupsRepo.getPaymentsByGroupId(group.id);
        const paidCount = payments.filter((p) => p.status === 'paid').length;
        return {
          id: group.id,
          totalMinor: group.total_minor,
          totalFormatted: moneyService.format(group.total_minor, group.currency),
          currency: group.currency,
          deadline: group.deadline,
          status: group.status,
          paidCount,
          totalFriends: payments.length,
          isConfirmed: group.status === 'confirmed',
          payments: payments.map((p) => ({
            id: p.id,
            friendName: p.friend_name,
            contact: p.contact,
            shareMinor: p.share_minor,
            shareFormatted: moneyService.format(p.share_minor, group.currency),
            status: p.status,
            publicToken: p.public_token
          }))
        };
      })
    );
    sendSuccess(res, { groups: enriched }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

groupsRouter.post('/api/groups', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const input = CreateGroupSchema.parse(req.body);

    if (input.suggestionId) {
      const suggestion = await suggestionsRepo.getById(input.suggestionId);
      if (!suggestion || suggestion.user_id !== authReq.userId) {
        sendError(res, 'FORBIDDEN', 'Suggestion does not exist or does not belong to the user.', 403);
        return;
      }
    }

    if (input.transactionId) {
      const transaction = await transactionsRepo.getById(input.transactionId);
      if (!transaction || transaction.user_id !== authReq.userId) {
        sendError(res, 'FORBIDDEN', 'Transaction does not exist or does not belong to the user.', 403);
        return;
      }
    }

    if (input.splitMode === 'custom') {
      for (const friend of input.friends) {
        if (!friend.shareMinor || friend.shareMinor <= 0) {
          sendError(res, 'VALIDATION_FAILED', 'All friends must have a positive shareMinor in custom split mode.', 400);
          return;
        }
      }
      if (input.totalMinor) {
        const sumShares = input.friends.reduce((acc, f) => acc + (f.shareMinor ?? 0), 0);
        if (sumShares > input.totalMinor) {
          sendError(res, 'VALIDATION_FAILED', 'Total of friend shares exceeds the overall bill amount.', 400);
          return;
        }
      }
    }

    const result = await splitterAgent.createGroupSplit(authReq.userId, {
      ...input,
      requestId: authReq.requestId
    });

    sendSuccess(
      res,
      {
        groupId: result.group.id,
        group: result.group,
        payments: result.payments,
        approvalId: result.approval?.id,
        preview: result.preview
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

/**
 * The money ledger for one outing: every capture and refund, and what Pocketful's PayPal account currently holds.
 * Funds are collected by the platform; this is a record, not a payout (there is no payout to the organizer).
 */
groupsRouter.get('/api/groups/:id/settlement', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const id = req.params['id'] as string;
    const group = await groupsRepo.getGroupById(id);
    if (!group || group.organizer_id !== authReq.userId) {
      sendError(res, 'NOT_FOUND', 'Group not found.', 404, undefined, authReq.requestId);
      return;
    }
    const [summary, entries] = await Promise.all([settlementsRepo.summarize(id), settlementsRepo.listForGroup(id)]);
    sendSuccess(
      res,
      {
        ...summary,
        currency: summary.currency ?? group.currency,
        heldBy: 'platform',
        entries: entries.map((e) => ({
          id: e.id,
          paymentId: e.payment_id,
          kind: e.kind,
          amountMinor: Number(e.amount_minor),
          currency: e.currency,
          actor: e.actor,
          createdAt: e.created_at
        }))
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

groupsRouter.get('/api/groups/:id', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const id = req.params['id'] as string;
    const group = await groupsRepo.getGroupById(id);
    if (!group || group.organizer_id !== authReq.userId) {
      sendError(res, 'NOT_FOUND', 'Group not found.', 404);
      return;
    }

    const payments = await groupsRepo.getPaymentsByGroupId(id);
    const paidCount = payments.filter((p) => p.status === 'paid').length;

    sendSuccess(
      res,
      {
        group,
        totalFormatted: moneyService.format(group.total_minor, group.currency),
        paidCount,
        totalFriends: payments.length,
        isConfirmed: group.status === 'confirmed',
        payments: payments.map((p) => ({
          id: p.id,
          friendName: p.friend_name,
          contact: p.contact,
          shareMinor: p.share_minor,
          shareFormatted: moneyService.format(p.share_minor, group.currency),
          status: p.status,
          publicToken: p.public_token,
          payUrl: p.pay_url,
          paidAt: p.paid_at
        }))
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

groupsRouter.post('/api/groups/:id/cancel', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const id = req.params['id'] as string;
    const group = await groupsRepo.getGroupById(id);
    if (!group || group.organizer_id !== authReq.userId) {
      sendError(res, 'NOT_FOUND', 'Group not found.', 404);
      return;
    }

    if (group.status === 'cancelled' || group.status === 'refunded') {
      sendSuccess(res, { status: group.status, message: `Group is already ${group.status}.` }, authReq.requestId);
      return;
    }

    const payments = await groupsRepo.getPaymentsByGroupId(id);
    const paidPayments = payments.filter((p) => p.status === 'paid' && p.capture_id);

    if (paidPayments.length > 0) {
      await approvalsRepo.voidPendingForGroup(group.id);
      // Stop further captures immediately; paid shares are refunded when the organizer approves
      // (or automatically when the deadline passes).
      await groupsRepo.cancelUnpaidPayments(group.id);
      const approval = await splitterAgent.stageGroupRefund(id, authReq.userId);
      sendSuccess(
        res,
        {
          approvalId: approval.id,
          preview: approval.preview,
          status: 'refunding_staged',
          paidCount: paidPayments.length
        },
        authReq.requestId
      );
    } else {
      await groupsRepo.cancelUnpaidPayments(id);
      await groupsRepo.updateGroupStatus(id, 'cancelled');
      await approvalsRepo.voidPendingForGroup(group.id);
      sendSuccess(
        res,
        {
          status: 'cancelled',
          message: 'Group outing cancelled.'
        },
        authReq.requestId
      );
    }
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
