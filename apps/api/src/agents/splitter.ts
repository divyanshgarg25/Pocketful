import { recordRefund } from '../services/settlement.js';
import { groupsRepo } from '../repos/groups.js';
import { profilesRepo } from '../repos/profiles.js';
import { suggestionsRepo } from '../repos/suggestions.js';
import { venuesRepo } from '../repos/venues.js';
import { moneyService } from '../services/money.js';
import { paypalService } from '../services/paypal.js';
import { guardianAgent } from './guardian.js';
import { auditRepo } from '../repos/audit.js';
import { NotFoundError, ValidationError, GuardianBlockedError, UpstreamError } from '../core/errors.js';
import type { Group, GroupPayment, Approval } from '../schemas/domain.js';
import crypto from 'crypto';

export interface FriendInput {
  name: string;
  contact: string;
  shareMinor?: number;
}

/**
 * Equal split with remainder pennies rotated by a deterministic offset seeded from (organizer, total, friend count).
 * Deterministic on purpose: the UI previews it via POST /api/groups/preview and staging recomputes the identical
 * value, so the amounts the organizer approves can never differ from the ones friends are asked to pay.
 * Friends keep their submitted order; the organizer is the last participant (index = friendCount).
 */
export function computeEqualSplit(
  organizerId: string,
  totalMinor: number,
  friendCount: number
): { friendShares: number[]; organizerShareMinor: number } {
  const participants = friendCount + 1;
  const seed = crypto.createHash('sha256').update(`${organizerId}|${totalMinor}|${friendCount}`).digest().readUInt32BE(0);
  const shares = moneyService.splitEqual(totalMinor, participants, seed);
  return { friendShares: shares.slice(0, friendCount), organizerShareMinor: shares[friendCount]! };
}

export class SplitterAgent {
  readonly name = 'splitter';

  /**
   * Create a group outing bill split and stage a send_requests approval
   */
  async createGroupSplit(
    organizerId: string,
    params: {
      suggestionId?: string;
      transactionId?: string;
      totalMinor?: number;
      friends: FriendInput[];
      splitMode: 'equal' | 'custom';
      deadlineHours?: number;
      requestId?: string;
    }
  ): Promise<{ group: Group; payments: GroupPayment[]; approval: Approval | null; preview: string }> {
    const organizer = await profilesRepo.getById(organizerId);
    if (!organizer) throw new NotFoundError('Organizer profile not found.');

    let totalMinor = params.totalMinor ?? 0;

    // If suggestionId provided, compute total from estimated venue cost
    if (!totalMinor && params.suggestionId) {
      const suggestion = await suggestionsRepo.getById(params.suggestionId);
      if (suggestion) {
        const venue = await venuesRepo.getById(suggestion.venue_id);
        if (venue) {
          const perPerson = venue.est_cost_high_minor ?? 2500;
          totalMinor = perPerson * (params.friends.length + 1); // Friends + organizer
        }
      }
    }

    if (totalMinor <= 0) {
      throw new ValidationError('Total split amount must be greater than zero.');
    }

    const deadline = new Date(Date.now() + (params.deadlineHours ?? 48) * 3600000).toISOString();
    const groupId = crypto.randomUUID();
    let shares: number[] = [];

    if (params.splitMode === 'equal') {
      // Same function the preview endpoint uses, so what the user sees is exactly what friends are asked to pay.
      const eq = computeEqualSplit(organizerId, totalMinor, params.friends.length);
      shares = [...eq.friendShares, eq.organizerShareMinor];
    } else {
      // Custom mode: validate sum
      const friendShares = params.friends.map((f) => f.shareMinor ?? 0);
      const friendTotal = friendShares.reduce((a, b) => a + b, 0);
      const organizerShare = totalMinor - friendTotal;
      if (organizerShare < 0) {
        throw new ValidationError('Total of friend shares exceeds the overall bill amount.');
      }
      shares = [...friendShares, organizerShare];
    }

    const group: Group = {
      id: groupId,
      organizer_id: organizerId,
      suggestion_id: params.suggestionId ?? null,
      transaction_id: params.transactionId ?? null,
      total_minor: totalMinor,
      currency: organizer.currency,
      deadline,
      status: 'draft',
      created_at: new Date().toISOString()
    };
    await groupsRepo.createGroup(group);

    const payments: GroupPayment[] = [];
    for (let i = 0; i < params.friends.length; i++) {
      const friend = params.friends[i]!;
      const share = shares[i]!;
      const paymentId = crypto.randomUUID();
      const token = crypto.randomBytes(16).toString('hex');

      payments.push({
        id: paymentId,
        group_id: groupId,
        friend_name: friend.name,
        contact: friend.contact,
        share_minor: share,
        public_token: token,
        paypal_ref: null,
        pay_url: null,
        capture_id: null,
        refund_ref: null,
        status: 'draft',
        paid_at: null,
        last_nudged_at: null
      });
    }

    await groupsRepo.createPayments(payments);

    // Build plain-language preview for the Guardian seal
    const previewItems = payments
      .map((p) => `${p.friend_name}: ${moneyService.format(p.share_minor, organizer.currency)}`)
      .join(', ');

    const preview = `Send PayPal payment requests to ${payments.length} friends (${previewItems}). Total group bill: ${moneyService.format(
      totalMinor,
      organizer.currency
    )}. Confirming automatically when all shares clear.`;

    const { approval, blockedReason } = await guardianAgent.requestApproval(
      organizer,
      {
        type: 'send_requests',
        amountMinor: totalMinor,
        payload: {
          groupId,
          paymentIds: payments.map((p) => p.id),
          organizerShareMinor: shares[shares.length - 1] ?? 0
        },
        preview,
        idempotencyKey: `group_split_${groupId}`
      },
      params.requestId
    );

    if (blockedReason) {
      throw new GuardianBlockedError(`Split request blocked: ${blockedReason}`);
    }

    return { group, payments, approval, preview };
  }

  /**
   * Execute the send_requests approval: creates real PayPal Sandbox orders & checkout links
   */
  async executeSendRequests(approvalId: string, userId: string, requestId?: string): Promise<{ sentCount: number }> {
    const user = await profilesRepo.getById(userId);
    if (!user) throw new NotFoundError('User not found.');

    const execution = await guardianAgent.executeApprovedAction(
      approvalId,
      user,
      async (payload) => {
        const groupId = payload['groupId'] as string;
        const group = await groupsRepo.getGroupById(groupId);
        if (!group) throw new NotFoundError('Group not found.');

        const payments = await groupsRepo.getPaymentsByGroupId(groupId);
        let sentCount = 0;

        for (const p of payments) {
          const order = await paypalService.createFriendSplitOrder(
            p.friend_name,
            p.share_minor,
            group.currency,
            `${groupId}:${p.id}`
          );

          await groupsRepo.updatePaymentStatus(
            p.id,
            'sent',
            undefined,
            undefined,
            order.orderId,
            order.payUrl
          );
          p.paypal_ref = order.orderId;
          p.pay_url = order.payUrl;
          p.status = 'sent';
          sentCount++;
        }

        await groupsRepo.updateGroupStatus(groupId, 'pending');

        await auditRepo.log({
          user_id: user.id,
          request_id: requestId,
          agent: this.name,
          action: 'split_requests_sent',
          params: { groupId, sentCount },
          result: { ok: true, sentCount }
        });

        return { sentCount };
      },
      requestId
    );

    return execution.result;
  }

  /**
   * Stage and execute group refund when deadline expires or organizer cancels
   */
  async stageGroupRefund(groupId: string, organizerId: string): Promise<Approval> {
    const organizer = await profilesRepo.getById(organizerId);
    if (!organizer) throw new NotFoundError('Organizer not found.');

    const group = await groupsRepo.getGroupById(groupId);
    if (!group) throw new NotFoundError('Group not found.');

    const payments = await groupsRepo.getPaymentsByGroupId(groupId);
    const paidPayments = payments.filter((p) => p.status === 'paid' && p.capture_id);

    const totalRefundMinor = paidPayments.reduce((acc, curr) => acc + curr.share_minor, 0);
    const names = paidPayments.map((p) => p.friend_name).join(', ');

    const preview = `Refund paid shares for ${paidPayments.length} friends (${names}). Total refunded: ${moneyService.format(
      totalRefundMinor,
      group.currency
    )}.`;

    const { approval, blockedReason } = await guardianAgent.requestApproval(organizer, {
      type: 'refund_group',
      amountMinor: totalRefundMinor,
      payload: { groupId, paymentIds: paidPayments.map((p) => p.id) },
      preview,
      idempotencyKey: `refund_group_${groupId}`
    });

    if (blockedReason || !approval) {
      throw new GuardianBlockedError(`Refund blocked: ${blockedReason ?? 'Failed to stage approval'}`);
    }

    return approval;
  }

  /**
   * Refunds every payment that is `paid` right now, cancels everything unpaid (CAS, so a payment that
   * just became paid is never overwritten), and only marks the group finished when nothing remains paid.
   * Each refund is idempotent at PayPal (Request-Id derives from the capture). If any refund fails the
   * others still run, then this throws so the caller can retry.
   */
  async refundAllPaid(
    groupId: string,
    opts: { finalStatus: 'refunded' | 'cancelled'; actor: string; requestId?: string }
  ): Promise<{ refundedCount: number; totalRefundMinor: number; failedCount: number }> {
    const group = await groupsRepo.getGroupById(groupId);
    if (!group) throw new NotFoundError('Group not found.');

    await groupsRepo.cancelUnpaidPayments(groupId); // stop new captures first

    const payments = await groupsRepo.getPaymentsByGroupId(groupId);
    let refundedCount = 0;
    let totalRefundMinor = 0;
    let failedCount = 0;

    for (const payment of payments) {
      if (payment.status !== 'paid' || !payment.capture_id) continue;
      try {
        const refund = await paypalService.refundCapture(payment.capture_id, 'Group outing cancelled/refunded');
        await groupsRepo.updatePaymentStatus(payment.id, 'refunded', undefined, undefined, undefined, undefined, refund.refundId);
        await recordRefund(group, payment, payment.capture_id, refund.refundId, opts.actor === 'system' ? 'system' : 'organizer');
        refundedCount++;
        totalRefundMinor += payment.share_minor;
      } catch {
        failedCount++;
      }
    }

    const after = await groupsRepo.getPaymentsByGroupId(groupId);
    const stillPaid = after.some((p) => p.status === 'paid');
    const inFlight = after.some((p) => p.status === 'capturing');
    if (!stillPaid && !inFlight) {
      await groupsRepo.updateGroupStatus(groupId, opts.finalStatus);
    }

    await auditRepo.log({
      user_id: opts.actor === 'system' ? null : opts.actor,
      request_id: opts.requestId,
      agent: opts.actor === 'system' ? 'system' : this.name,
      action: 'group_refund_completed',
      params: { groupId, refundedCount, totalRefundMinor, failedCount },
      result: { ok: failedCount === 0, refundedCount, totalRefundMinor, failedCount }
    });

    if (failedCount > 0 || stillPaid || inFlight) {
      throw new UpstreamError(
        `Refund incomplete for group (${failedCount} failed${inFlight ? ', capture in flight' : ''}); retry needed.`
      );
    }
    return { refundedCount, totalRefundMinor, failedCount };
  }

  /**
   * Execute the refund_group approval: refunds all cleared PayPal payments
   */
  async executeGroupRefund(
    approvalId: string,
    userId: string,
    requestId?: string
  ): Promise<{ refundedCount: number; totalRefundMinor: number }> {
    const user = await profilesRepo.getById(userId);
    if (!user) throw new NotFoundError('User not found.');

    const execution = await guardianAgent.executeApprovedAction(
      approvalId,
      user,
      async (payload) => {
        const groupId = payload['groupId'] as string;
        // Refund EVERYONE who is paid at execution time, not just the list staged earlier.
        const r = await this.refundAllPaid(groupId, { finalStatus: 'refunded', actor: user.id, requestId });
        return { refundedCount: r.refundedCount, totalRefundMinor: r.totalRefundMinor };
      },
      requestId
    );

    return execution.result;
  }
}

export const splitterAgent = new SplitterAgent();
