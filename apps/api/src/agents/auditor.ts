import { subscriptionsRepo } from '../repos/subscriptions.js';
import { profilesRepo } from '../repos/profiles.js';
import { approvalsRepo } from '../repos/approvals.js';
import { geminiService } from '../services/gemini.js';
import { guardianAgent } from './guardian.js';
import { moneyService } from '../services/money.js';
import { paypalService } from '../services/paypal.js';
import { auditRepo } from '../repos/audit.js';
import { eventBus } from '../core/events.js';
import { NotFoundError } from '../core/errors.js';
import type { Subscription, Approval } from '../schemas/domain.js';

export interface AuditResult {
  totalMonthlyWasteMinor: number;
  totalYearlyWasteMinor: number;
  totalYearlyWasteFormatted: string;
  ghostSubscriptions: Array<Subscription & { explanation: string }>;
  activeCount: number;
}

export class AuditorAgent {
  readonly name = 'auditor';

  /**
   * Run the Ghost Subscription Audit
   * Arithmetic is 100% computed in code. Explanations from Gemini.
   */
  async runAudit(userId: string): Promise<AuditResult> {
    const subscriptions = await subscriptionsRepo.getByUserId(userId);
    const now = Date.now();

    const activeSubs = subscriptions.filter((s) => s.status === 'active');
    const ghostCandidates: Subscription[] = [];

    let totalMonthlyWasteMinor = 0;

    for (const sub of activeSubs) {
      let isGhost = sub.flagged_ghost;

      // Check if snoozed
      if (sub.ghost_snoozed_until && new Date(sub.ghost_snoozed_until).getTime() > now) {
        continue;
      }

      // Check 90-day inactivity signal
      if (!isGhost && sub.last_used_signal) {
        const lastUsed = new Date(sub.last_used_signal).getTime();
        if (now - lastUsed > 90 * 86400000) {
          isGhost = true;
        }
      }

      if (isGhost) {
        ghostCandidates.push(sub);
        // Monthly normalized minor units
        const monthlyAmount = moneyService.normalizeToMonthlyMinor(sub.amount_minor, sub.interval);
        totalMonthlyWasteMinor += monthlyAmount;
      }
    }

    const totalYearlyWasteMinor = totalMonthlyWasteMinor * 12;

    // Get plain-language explanations from Gemini
    const explanationsResult = await geminiService.explainGhostSubscriptions(
      ghostCandidates.map((g) => ({
        id: g.id,
        merchant: g.merchant,
        amountFormatted: moneyService.format(g.amount_minor),
        daysUnused: g.last_used_signal
          ? Math.floor((now - new Date(g.last_used_signal).getTime()) / 86400000)
          : 90
      }))
    );

    const explanationMap = new Map<string, string>();
    for (const exp of explanationsResult.explanations) {
      explanationMap.set(exp.subscription_id, exp.reason);
    }

    const ghostSubscriptions = ghostCandidates.map((g) => ({
      ...g,
      explanation: explanationMap.get(g.id) ?? g.ghost_reason ?? 'Unused recurring payment detected.'
    }));

    return {
      totalMonthlyWasteMinor,
      totalYearlyWasteMinor,
      totalYearlyWasteFormatted: moneyService.format(totalYearlyWasteMinor),
      ghostSubscriptions,
      activeCount: activeSubs.length
    };
  }

  /**
   * Stage a cancellation approval via Guardian
   */
  async stageCancellation(
    userId: string,
    subscriptionIds: string[],
    requestId?: string
  ): Promise<{ approval: Approval | null; blockedReason?: string; yearlySavingMinor: number }> {
    const user = await profilesRepo.getById(userId);
    if (!user) throw new NotFoundError('User profile not found.');

    const subs = await subscriptionsRepo.getByUserId(userId);
    const toCancel = subs.filter((s) => subscriptionIds.includes(s.id) && s.status === 'active');

    if (toCancel.length === 0) {
      throw new NotFoundError('No active subscriptions found matching the provided IDs.');
    }

    let monthlyTotalMinor = 0;
    const merchantNames: string[] = [];

    for (const s of toCancel) {
      merchantNames.push(s.merchant);
      const monthly = moneyService.normalizeToMonthlyMinor(s.amount_minor, s.interval);
      monthlyTotalMinor += monthly;
    }

    const yearlySavingMinor = monthlyTotalMinor * 12;
    const namesList = merchantNames.join(', ');

    const preview = `Cancel ${namesList}. Saves ${moneyService.format(
      monthlyTotalMinor
    )}/mo (${moneyService.format(
      yearlySavingMinor
    )}/yr). Recovered cash is immediately reinvested into your available weekend budget.`;

    const { approval, blockedReason } = await guardianAgent.requestApproval(
      user,
      {
        type: 'cancel_subscription',
        amountMinor: monthlyTotalMinor,
        payload: { subscriptionIds: toCancel.map((s) => s.id) },
        preview,
        idempotencyKey: `cancel_sub_${toCancel.map((s) => s.id).sort().join('_')}`
      },
      requestId
    );

    return { approval, blockedReason, yearlySavingMinor };
  }

  /**
   * Execute the cancellation after Guardian seal
   */
  async executeCancellation(
    approvalId: string,
    userId: string,
    requestId?: string
  ): Promise<{ cancelledIds: string[]; savedMonthlyMinor: number }> {
    const user = await profilesRepo.getById(userId);
    if (!user) throw new NotFoundError('User not found.');

    const execution = await guardianAgent.executeApprovedAction(
      approvalId,
      user,
      async (payload) => {
        const ids = (payload['subscriptionIds'] as string[]) ?? [];
        const cancelledIds: string[] = [];
        let savedMonthlyMinor = 0;

        for (const id of ids) {
          const sub = await subscriptionsRepo.getById(id);
          if (sub && sub.status === 'active') {
            if (sub.paypal_subscription_id) {
              await paypalService.cancelSubscription(
                sub.paypal_subscription_id,
                'Cancelled via Pocketful Cancel & Reinvest'
              );
            }
            const updated = await subscriptionsRepo.updateStatus(sub.id, 'cancelled');
            if (updated) {
              cancelledIds.push(updated.id);
              let m = updated.amount_minor;
              if (updated.interval === 'yearly') m = Math.round(m / 12);
              savedMonthlyMinor += m;

              const actualApproval = await approvalsRepo.getById(approvalId);
              if (actualApproval) {
                eventBus.emitEvent('subscription.cancelled', {
                  subscription: updated,
                  approval: actualApproval
                });
              }
            }
          }
        }

        await auditRepo.log({
          user_id: user.id,
          request_id: requestId,
          agent: this.name,
          action: 'cancel_and_reinvest_completed',
          params: { cancelledIds, savedMonthlyMinor },
          result: { ok: true, cancelledIds, savedMonthlyMinor }
        });

        return { cancelledIds, savedMonthlyMinor };
      },
      requestId
    );

    return execution.result;
  }
}

export const auditorAgent = new AuditorAgent();
