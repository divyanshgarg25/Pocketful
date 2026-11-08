import { Router } from 'express';
import { z } from 'zod';
import { profilesRepo } from '../repos/profiles.js';
import { guardianAgent } from '../agents/guardian.js';
import { vaultRepo } from '../repos/vault.js';
import { subscriptionsRepo } from '../repos/subscriptions.js';
import { plansRepo } from '../repos/plans.js';
import { suggestionsRepo } from '../repos/suggestions.js';
import { transactionsRepo } from '../repos/transactions.js';
import { groupsRepo } from '../repos/groups.js';
import { banditRepo } from '../repos/bandit.js';
import { approvalsRepo } from '../repos/approvals.js';
import { auditRepo } from '../repos/audit.js';
import { sendSuccess, sendError, handleRouteError, NotFoundError, ValidationError } from '../core/errors.js';
import { moneyService, CURRENCY_EXPONENTS } from '../services/money.js';
import { assertCurrencyChangeAllowed } from '../services/currency.js';
import type { AuthenticatedRequest } from '../core/auth.js';

export const meRouter = Router();

meRouter.get('/api/me', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const profile = await profilesRepo.getById(authReq.userId);
    if (!profile) {
      throw new NotFoundError('User profile not found');
    }
    const preferences = await profilesRepo.getPreferences(authReq.userId);

    sendSuccess(res, { profile, preferences }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const SettingsPatchSchema = z
  .object({
    maxDistanceKm: z.number().min(1).max(100).optional(),
    guiltFreeCapMinor: z.number().int().nonnegative().max(10_000_000_00).optional(),
    perActionCapMinor: z.number().int().nonnegative().max(10_000_000_00).optional(),
    weeklyCapMinor: z.number().int().nonnegative().max(10_000_000_00).optional(),
    currency: z.enum(Object.keys(CURRENCY_EXPONENTS) as [string, ...string[]]).optional(),
    optInMood: z.boolean().optional(),
    optInTracking: z.boolean().optional(),
    explorationLevel: z.enum(['off', 'low', 'normal']).optional()
  })
  .strict();

meRouter.patch('/api/me/settings', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const input = SettingsPatchSchema.parse(req.body);
    const existing = await profilesRepo.getById(authReq.userId);
    if (!existing) throw new NotFoundError('Profile not found.');

    const isRaisingCaps =
      (input.perActionCapMinor !== undefined && input.perActionCapMinor > existing.per_action_cap_minor) ||
      (input.weeklyCapMinor !== undefined && input.weeklyCapMinor > existing.weekly_cap_minor);

    const isChangingCurrency = input.currency !== undefined && input.currency !== existing.currency;
    if (isChangingCurrency) {
      if (Object.keys(input).length > 1) {
        throw new ValidationError('Change your currency on its own, separately from other settings.');
      }
      const target = input.currency as string;
      await assertCurrencyChangeAllowed(existing);
      const { approval, blockedReason } = await guardianAgent.requestApproval(
        existing,
        {
          type: 'change_currency',
          amountMinor: 0,
          payload: { from: existing.currency, to: target },
          preview: `Switch currency from ${existing.currency} to ${target}. Your safety caps keep the same number (${moneyService.format(
            existing.weekly_cap_minor,
            existing.currency
          )} weekly becomes ${moneyService.format(
            moneyService.convertMinorPreservingMajor(existing.weekly_cap_minor, existing.currency, target),
            target
          )}); no exchange rate is applied.`,
          idempotencyKey: `change_currency_${authReq.userId}_${target}_${Date.now()}`
        },
        authReq.requestId
      );
      if (blockedReason || !approval) {
        sendError(res, 'GUARDIAN_BLOCKED', blockedReason ?? 'Currency change blocked by safety policy.', 403);
        return;
      }
      sendSuccess(
        res,
        { status: 'pending', requiresApproval: true, approval, message: 'Guardian approval staged. Step-up authorization required to change currency.' },
        authReq.requestId
      );
      return;
    }

    if (isRaisingCaps) {
      const { approval, blockedReason } = await guardianAgent.requestApproval(
        existing,
        {
          type: 'change_caps',
          amountMinor: 0,
          payload: {
            per_action_cap_minor: input.perActionCapMinor ?? existing.per_action_cap_minor,
            weekly_cap_minor: input.weeklyCapMinor ?? existing.weekly_cap_minor
          },
          preview: `Raise safety caps to per-action: ${moneyService.format(
            input.perActionCapMinor ?? existing.per_action_cap_minor,
            existing.currency
          )}, weekly: ${moneyService.format(input.weeklyCapMinor ?? existing.weekly_cap_minor, existing.currency)}.`,
          idempotencyKey: `change_caps_${authReq.userId}_${Date.now()}`
        },
        authReq.requestId
      );

      if (blockedReason || !approval) {
        sendError(res, 'GUARDIAN_BLOCKED', blockedReason ?? 'Raising caps blocked by safety policy.', 403);
        return;
      }

      sendSuccess(
        res,
        {
          status: 'pending',
          requiresApproval: true,
          approval,
          message: 'Guardian approval staged. Step-up authorization required to raise spending caps.'
        },
        authReq.requestId
      );
      return;
    }

    const updated = await profilesRepo.upsert({
      ...existing,
      max_distance_km: input.maxDistanceKm ?? existing.max_distance_km,
      guilt_free_cap_minor: input.guiltFreeCapMinor ?? existing.guilt_free_cap_minor,
      per_action_cap_minor: input.perActionCapMinor ?? existing.per_action_cap_minor,
      weekly_cap_minor: input.weeklyCapMinor ?? existing.weekly_cap_minor,
      currency: existing.currency, // currency only changes through the change_currency approval
      opt_in_mood: input.optInMood ?? existing.opt_in_mood,
      opt_in_tracking: input.optInTracking ?? existing.opt_in_tracking,
      exploration_level: input.explorationLevel ?? existing.exploration_level
    });

    sendSuccess(res, { profile: updated }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

// GDPR Data Export Endpoint
meRouter.get('/api/me/export', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const userId = authReq.userId;

    const [
      profile,
      preferences,
      pockets,
      vault,
      subscriptions,
      plans,
      suggestions,
      transactions,
      groups,
      banditStateMap,
      learningEvents,
      approvals,
      auditLogs
    ] = await Promise.all([
      profilesRepo.getById(userId),
      profilesRepo.getPreferences(userId),
      vaultRepo.getPockets(userId),
      vaultRepo.getVault(userId),
      subscriptionsRepo.getByUserId(userId),
      plansRepo.getByUserId(userId),
      suggestionsRepo.getByUserId(userId),
      transactionsRepo.getByUserId(userId),
      groupsRepo.getGroupsByOrganizer(userId),
      banditRepo.getBanditStateForUser(userId),
      banditRepo.getEventsForUser(userId, true),
      approvalsRepo.getByUserId(userId),
      auditRepo.getByUserId(userId)
    ]);

    // Fetch payments for user's organized groups
    const groupPayments = [];
    for (const g of groups) {
      const pmts = await groupsRepo.getPaymentsByGroupId(g.id);
      groupPayments.push(...pmts);
    }

    const exportData = {
      exported_at: new Date().toISOString(),
      user_id: userId,
      profile,
      preferences,
      pockets,
      vault,
      subscriptions,
      plans,
      suggestions,
      transactions,
      groups,
      group_payments: groupPayments,
      bandit_state: Array.from(banditStateMap.values()),
      learning_events: learningEvents,
      approvals,
      audit_logs: auditLogs
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="pocketful-data-export-${userId}.json"`);
    sendSuccess(res, exportData, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

// GDPR Data Erasure Endpoint: Strictly routes through Guardian Protocol
meRouter.delete('/api/me/data', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const user = await profilesRepo.getById(authReq.userId);
    if (!user) throw new NotFoundError('User profile not found.');

    const { approval, blockedReason } = await guardianAgent.requestApproval(
      user,
      {
        type: 'delete_data',
        amountMinor: 0,
        payload: { erase: true },
        preview: 'Permanently erase all personal profile data, transaction history, and learning preferences.',
        idempotencyKey: `delete_data_${authReq.userId}`
      },
      authReq.requestId
    );

    if (blockedReason || !approval) {
      sendError(res, 'GUARDIAN_BLOCKED', blockedReason ?? 'Data deletion blocked by safety policy.', 403);
      return;
    }

    sendSuccess(
      res,
      {
        status: 'pending',
        requiresApproval: true,
        approval,
        message: 'Guardian approval staged. Step-up authorization required to permanently delete account data.'
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
