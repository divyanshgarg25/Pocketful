import { describe, it, expect, beforeEach } from 'vitest';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { jobRunner } from '../src/jobs/runner.js';
import { groupsRepo } from '../src/repos/groups.js';
import { vaultRepo } from '../src/repos/vault.js';
import { profilesRepo } from '../src/repos/profiles.js';
import type { Group, GroupPayment } from '../src/schemas/domain.js';

describe('Phase 6: Multi-User Job Scheduling & Concurrency Locks (H5)', () => {
  const userAaravId = '00000000-0000-4000-a000-000000000001';
  const userPriyaId = '00000000-0000-4000-a000-000000000002';

  beforeEach(() => {
    initLocalSeed();
  });

  describe('Concurrency Lease / Row Lock Mechanism', () => {
    it('prevents concurrent execution of the same job across workers', async () => {
      const lease1 = await jobRunner.acquireLease('test_critical_job', 5);
      expect(lease1).toBeTruthy();

      // Second attempt to acquire lock while lease1 is running must fail (return null)
      const lease2 = await jobRunner.acquireLease('test_critical_job', 5);
      expect(lease2).toBeNull();

      // Once lease1 is released, subsequent lock acquisition succeeds
      await jobRunner.releaseLease(lease1!, 'ok');

      const lease3 = await jobRunner.acquireLease('test_critical_job', 5);
      expect(lease3).toBeTruthy();
      await jobRunner.releaseLease(lease3!, 'ok');
    });
  });

  describe('Multi-User Deadline Checks Across All Groups', () => {
    it('processes expired groups for multiple users and auto-refunds friends who paid, without waiting for the organizer', async () => {
      const pastDeadline = new Date(Date.now() - 3600000).toISOString(); // 1h ago

      // 1. Group for Aarav (with 1 paid friend)
      const g1Id = 'aaaa0001-0000-4000-a000-000000000001';
      const p1Id = 'bbbb0001-0000-4000-a000-000000000001';
      const group1: Group = {
        id: g1Id,
        organizer_id: userAaravId,
        suggestion_id: null,
        transaction_id: null,
        total_minor: 4000,
        currency: 'USD',
        deadline: pastDeadline,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      const payment1: GroupPayment = {
        id: p1Id,
        group_id: g1Id,
        friend_name: 'Ananya',
        contact: 'ananya@example.com',
        share_minor: 2000,
        public_token: 'token-g1-p1',
        paypal_ref: 'ORD-1',
        pay_url: 'https://paypal.com/pay',
        capture_id: 'CAP-1',
        refund_ref: null,
        status: 'paid', // Friend paid!
        paid_at: new Date().toISOString(),
        last_nudged_at: null
      };

      // 2. Group for Priya (with unpaid friends only)
      const g2Id = 'aaaa0002-0000-4000-a000-000000000002';
      const p2Id = 'bbbb0002-0000-4000-a000-000000000002';
      const group2: Group = {
        id: g2Id,
        organizer_id: userPriyaId,
        suggestion_id: null,
        transaction_id: null,
        total_minor: 6000,
        currency: 'USD',
        deadline: pastDeadline,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      const payment2: GroupPayment = {
        id: p2Id,
        group_id: g2Id,
        friend_name: 'Karan',
        contact: 'karan@example.com',
        share_minor: 3000,
        public_token: 'token-g2-p2',
        paypal_ref: 'ORD-2',
        pay_url: 'https://paypal.com/pay',
        capture_id: null,
        refund_ref: null,
        status: 'sent', // Not paid
        paid_at: null,
        last_nudged_at: null
      };

      await groupsRepo.createGroup(group1);
      await groupsRepo.createPayments([payment1]);

      await groupsRepo.createGroup(group2);
      await groupsRepo.createPayments([payment2]);

      // Run deadline checks across all users
      const handledCount = await jobRunner.checkAllDeadlines();
      expect(handledCount).toBe(2);

      // Group 1: friend's own money is refunded automatically; no approval is needed or staged
      const freshG1 = await groupsRepo.getGroupById(g1Id);
      expect(freshG1?.status).toBe('refunded');
      const freshP1 = await groupsRepo.getPaymentById(p1Id);
      expect(freshP1?.status).toBe('refunded');
      expect(freshP1?.refund_ref).toBeTruthy();
      const stagedRefund = Array.from(localDb.approvals.values()).find((a) => a.action_type === 'refund_group');
      expect(stagedRefund).toBeUndefined();
      expect(localDb.audit_log.some((a) => a.action === 'group_refund_completed' && a.agent === 'system')).toBe(true);

      // Verify Group 2 was cancelled directly
      const freshG2 = await groupsRepo.getGroupById(g2Id);
      expect(freshG2?.status).toBe('cancelled');
      const freshP2 = await groupsRepo.getPaymentById(p2Id);
      expect(freshP2?.status).toBe('cancelled');
    });
  });

  describe('Monday Weekly Pocket Reset to Guilt-Free Cap', () => {
    it('resets weekly pocket balance to profile guilt_free_cap_minor', async () => {
      const profile = await profilesRepo.getById(userAaravId);
      expect(profile).toBeTruthy();
      expect(profile!.guilt_free_cap_minor).toBe(15000); // $150.00

      // Simulate mid-week spent balance of $12.50
      await vaultRepo.updatePocket({
        user_id: userAaravId,
        kind: 'weekly',
        balance_minor: 1250,
        is_simulated: true
      });

      const midWeekPocket = await vaultRepo.getPocket(userAaravId, 'weekly');
      expect(midWeekPocket?.balance_minor).toBe(1250);

      // Trigger weekly reset job
      const res = await jobRunner.triggerJob('weeklyReset', userAaravId);
      expect(res).toContain('completed');

      const resetPocket = await vaultRepo.getPocket(userAaravId, 'weekly');
      expect(resetPocket?.balance_minor).toBe(15000);
    });
  });

  describe('Job Runner Lifecycle & Graceful Shutdown', () => {
    it('initializes and shuts down scheduled tasks cleanly', () => {
      jobRunner.initJobs();
      expect(() => jobRunner.shutdown()).not.toThrow();
    });
  });
});