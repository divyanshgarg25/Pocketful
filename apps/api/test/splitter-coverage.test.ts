import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { splitterAgent } from '../src/agents/splitter.js';
import { groupsRepo } from '../src/repos/groups.js';
import { paypalService } from '../src/services/paypal.js';
import { GuardianBlockedError, NotFoundError, ValidationError } from '../src/core/errors.js';

const userId = '00000000-0000-4000-a000-000000000001';
const friends = (n: number, shares?: number[]) =>
  Array.from({ length: n }, (_, i) => ({ name: `F${i + 1}`, contact: `f${i + 1}@example.com`, ...(shares ? { shareMinor: shares[i]! } : {}) }));
const missing = () => crypto.randomUUID();
/** The local seed has no venues/suggestions, so create the minimal pair the splitter reads. */
const seedSuggestion = (estCostHigh: number | null) => {
  const venueId = crypto.randomUUID();
  const suggestionId = crypto.randomUUID();
  localDb.venues.set(venueId, { id: venueId, est_cost_high_minor: estCostHigh } as never);
  localDb.suggestions.set(suggestionId, { id: suggestionId, user_id: userId, venue_id: venueId } as never);
  return suggestionId;
};

describe('Splitter: guards, derived totals and refunds', () => {
  beforeEach(() => {
    initLocalSeed();
    localDb.approvals.clear();
    localDb.groups.clear();
    localDb.group_payments.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  describe('createGroupSplit', () => {
    it('refuses an unknown organizer', async () => {
      await expect(splitterAgent.createGroupSplit(missing(), { totalMinor: 9000, friends: friends(2), splitMode: 'equal' })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('derives the total from the venue cost per person x (friends + organizer) when only a suggestion is given', async () => {
      const r = await splitterAgent.createGroupSplit(userId, { suggestionId: seedSuggestion(3000), friends: friends(2), splitMode: 'equal' });
      expect(r.group.total_minor).toBe(3000 * 3);
    });

    it('falls back to $25.00 per person when the venue has no cost estimate', async () => {
      const r = await splitterAgent.createGroupSplit(userId, { suggestionId: seedSuggestion(null), friends: friends(3), splitMode: 'equal' });
      expect(r.group.total_minor).toBe(2500 * 4);
    });

    it('an unknown suggestion yields no total, so the split is rejected', async () => {
      await expect(splitterAgent.createGroupSplit(userId, { suggestionId: missing(), friends: friends(2), splitMode: 'equal' })).rejects.toBeInstanceOf(ValidationError);
    });

    it.each([0, -100])('rejects a non-positive total (%i)', async (total) => {
      await expect(splitterAgent.createGroupSplit(userId, { totalMinor: total, friends: friends(2), splitMode: 'equal' })).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects custom shares that add up to more than the bill', async () => {
      await expect(
        splitterAgent.createGroupSplit(userId, { totalMinor: 5000, friends: friends(2, [3000, 3000]), splitMode: 'custom' })
      ).rejects.toThrow(/exceeds the overall bill/);
    });

    it('accepts custom shares and gives the organizer exactly the remainder', async () => {
      const r = await splitterAgent.createGroupSplit(userId, { totalMinor: 9000, friends: friends(2, [3000, 2500]), splitMode: 'custom' });
      expect(r.payments.map((p) => p.share_minor)).toEqual([3000, 2500]);
      expect((r.approval?.payload as { organizerShareMinor: number }).organizerShareMinor).toBe(3500);
    });

    it("is blocked by the Guardian when the organizer's own share exceeds their cap, and stages nothing", async () => {
      localDb.profiles.get(userId)!.per_action_cap_minor = 1000;
      await expect(splitterAgent.createGroupSplit(userId, { totalMinor: 9000, friends: friends(2), splitMode: 'equal' })).rejects.toBeInstanceOf(GuardianBlockedError);
      expect(localDb.approvals.size).toBe(0);
    });
  });

  describe('execution and refund guards', () => {
    it('executeSendRequests refuses an unknown user', async () => {
      await expect(splitterAgent.executeSendRequests(missing(), missing())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('stageGroupRefund refuses an unknown organizer and an unknown group', async () => {
      await expect(splitterAgent.stageGroupRefund(missing(), missing())).rejects.toBeInstanceOf(NotFoundError);
      await expect(splitterAgent.stageGroupRefund(missing(), userId)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('stageGroupRefund is blocked while spending is locked ($0 caps)', async () => {
      const g = await splitterAgent.createGroupSplit(userId, { totalMinor: 9000, friends: friends(2), splitMode: 'equal' });
      const p = [...localDb.group_payments.values()][0]!;
      await groupsRepo.updatePaymentStatus(p.id, 'paid', 'CAP1', new Date().toISOString());
      localDb.profiles.get(userId)!.weekly_cap_minor = 0;
      await expect(splitterAgent.stageGroupRefund(g.group.id, userId)).rejects.toBeInstanceOf(GuardianBlockedError);
    });

    it('refundAllPaid and executeGroupRefund refuse an unknown group / user', async () => {
      await expect(splitterAgent.refundAllPaid(missing(), { finalStatus: 'refunded', actor: 'test' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(splitterAgent.executeGroupRefund(missing(), missing())).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('refundAllPaid', () => {
    const paidGroup = async (n = 3) => {
      const g = await splitterAgent.createGroupSplit(userId, { totalMinor: 9000, friends: friends(n), splitMode: 'equal' });
      const ps = await groupsRepo.getPaymentsByGroupId(g.group.id);
      ps.forEach((p, i) => localDb.group_payments.set(p.id, { ...localDb.group_payments.get(p.id)!, status: 'paid', capture_id: `CAP_${i}` }));
      return g.group.id;
    };

    it('refunds every paid payment, totals the amounts, and closes the group', async () => {
      const id = await paidGroup(3);
      const r = await splitterAgent.refundAllPaid(id, { finalStatus: 'refunded', actor: 'test' });
      expect(r).toMatchObject({ refundedCount: 3, failedCount: 0 });
      expect(r.totalRefundMinor).toBe((await groupsRepo.getPaymentsByGroupId(id)).reduce((s, p) => s + p.share_minor, 0));
      expect((await groupsRepo.getGroupById(id))?.status).toBe('refunded');
    });

    it('a PayPal failure on one payment raises "retry needed" (never reported as success); the other refunds still stick and the group stays open', async () => {
      const id = await paidGroup(3);
      const refund = vi.spyOn(paypalService, 'refundCapture').mockImplementation(async (captureId: string) => {
        if (captureId === 'CAP_1') throw new Error('PayPal 500');
        return { refundId: `RF_${captureId}`, status: 'COMPLETED' };
      });
      await expect(splitterAgent.refundAllPaid(id, { finalStatus: 'refunded', actor: 'test' })).rejects.toThrow(/Refund incomplete.*1 failed.*retry/);
      const after = await groupsRepo.getPaymentsByGroupId(id);
      expect(after.filter((p) => p.status === 'refunded')).toHaveLength(2);
      expect(after.find((p) => p.capture_id === 'CAP_1')?.status).toBe('paid'); // still owed back
      expect((await groupsRepo.getGroupById(id))?.status).not.toBe('refunded');

      // A retry refunds only what is still owed (no double refund of the two already done), then closes the group.
      refund.mockClear();
      refund.mockImplementation(async (captureId: string) => ({ refundId: `RF_${captureId}`, status: 'COMPLETED' }));
      const retry = await splitterAgent.refundAllPaid(id, { finalStatus: 'refunded', actor: 'test' });
      expect(refund).toHaveBeenCalledTimes(1);
      expect(refund).toHaveBeenCalledWith('CAP_1', expect.any(String));
      expect(retry).toMatchObject({ refundedCount: 1, failedCount: 0 });
      expect((await groupsRepo.getGroupById(id))?.status).toBe('refunded');
    });

    it('skips payments that were never paid or have no capture to refund', async () => {
      const g = await splitterAgent.createGroupSplit(userId, { totalMinor: 9000, friends: friends(2), splitMode: 'equal' });
      const spy = vi.spyOn(paypalService, 'refundCapture');
      const r = await splitterAgent.refundAllPaid(g.group.id, { finalStatus: 'cancelled', actor: 'test' });
      expect(spy).not.toHaveBeenCalled();
      expect(r).toMatchObject({ refundedCount: 0, failedCount: 0, totalRefundMinor: 0 });
    });
  });
});
