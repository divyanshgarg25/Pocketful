import { Router } from 'express';
import { z } from 'zod';
import { vaultRepo } from '../repos/vault.js';
import { profilesRepo } from '../repos/profiles.js';
import { guardianAgent } from '../agents/guardian.js';
import { moneyService } from '../services/money.js';
import { sendSuccess, handleRouteError, sendError, NotFoundError } from '../core/errors.js';
import { getAuthReq } from '../core/auth.js';

export const vaultRouter = Router();

const MoodSchema = z.object({
  level: z.enum(['drained', 'okay', 'great'])
});

vaultRouter.post('/api/mood', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const profile = await profilesRepo.getById(authReq.userId);
    if (!profile?.opt_in_mood) {
      sendError(res, 'FORBIDDEN', 'User has not opted in to mood tracking.', 403, undefined, authReq.requestId);
      return;
    }
    const { level } = MoodSchema.parse(req.body);
    const checkin = await vaultRepo.saveMoodCheckin(authReq.userId, level);
    sendSuccess(res, { mood: checkin.level, checkinId: checkin.id, week: checkin.week, saved: true }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const VaultDecideSchema = z.object({
  action: z.enum(['lock_in', 'roll_over']),
  amountMinor: z.number().int().positive().max(10_000_000_00)
});

/**
 * Sunday Vault Decision: Strictly routes through the Guardian approval protocol
 */
vaultRouter.post('/api/vault/decide', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const { action, amountMinor } = VaultDecideSchema.parse(req.body);
    const user = await profilesRepo.getById(authReq.userId);
    if (!user) throw new NotFoundError('User profile not found.');

    const preview =
      action === 'lock_in'
        ? `Lock ${moneyService.format(amountMinor)} leftover cash into your savings vault.`
        : `Roll over ${moneyService.format(amountMinor)} leftover cash into your mega-weekend fund.`;

    // Strictly route through the Guardian Protocol
    const { approval, blockedReason } = await guardianAgent.requestApproval(
      user,
      {
        type: 'vault_move',
        amountMinor,
        payload: { action, amountMinor },
        preview,
        idempotencyKey: `vault_${action}_${amountMinor}`
      },
      authReq.requestId
    );

    if (blockedReason || !approval) {
      sendError(res, 'GUARDIAN_BLOCKED', blockedReason ?? 'Vault move blocked by Guardian spending policy.', 403);
      return;
    }

    sendSuccess(
      res,
      {
        status: 'pending',
        requiresApproval: true,
        approval,
        action,
        amountFormatted: moneyService.format(amountMinor),
        message: 'Guardian approval staged. Step-up authorization required to move money.'
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
