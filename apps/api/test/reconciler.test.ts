import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { jobRunner } from '../src/jobs/runner.js';
import { groupsRepo } from '../src/repos/groups.js';
import type { Approval, Group, GroupPayment } from '../src/schemas/domain.js';

const userId = '00000000-0000-4000-a000-000000000001';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function approval(over: Partial<Approval>): Approval {
  const a = {
    id: crypto.randomUUID(), user_id: userId, action_type: 'vault_move', payload: {}, preview: 'x',
    amount_minor: 100, money_out_minor: 100, status: 'pending', idempotency_key: crypto.randomUUID(),
    retry_count: 0, expires_at: new Date(Date.now() + 600000).toISOString(), ...over
  } as Approval;
  localDb.approvals.set(a.id, a);
  return a;
}

describe('Reconciler: nothing is left in limbo (B8)', () => {
  beforeEach(() => { initLocalSeed(); localDb.approvals.clear(); localDb.job_runs.clear(); });

  it('expires stale pending/approved approvals', async () => {
    const p = approval({ status: 'pending', expires_at: ago(1000) });
    const ap = approval({ status: 'approved', decided_at: ago(20 * 60_000) });
    const fresh = approval({ status: 'approved', decided_at: ago(60_000) });
    await jobRunner.reconcileStuckWork();
    expect(localDb.approvals.get(p.id)!.status).toBe('expired');
    expect(localDb.approvals.get(ap.id)!.status).toBe('expired');
    expect(localDb.approvals.get(fresh.id)!.status).toBe('approved');
  });

  it('executing WITH an outcome is finalized as executed (never re-run); without one it fails for retry', async () => {
    const done = approval({ status: 'executing', decided_at: ago(5 * 60_000), execution_outcome: { moved: true } });
    const lost = approval({ status: 'executing', decided_at: ago(20 * 60_000) });
    const young = approval({ status: 'executing', decided_at: ago(30_000) });
    await jobRunner.reconcileStuckWork();
    expect(localDb.approvals.get(done.id)!.status).toBe('executed');
    expect(localDb.approvals.get(lost.id)!.status).toBe('failed');
    expect(localDb.approvals.get(young.id)!.status).toBe('executing');
  });

  it('releases stale capture claims and retries failed late refunds', async () => {
    const gid = crypto.randomUUID();
    await groupsRepo.createGroup({ id: gid, organizer_id: userId, suggestion_id: null, transaction_id: null, total_minor: 6000,
      currency: 'USD', deadline: new Date(Date.now() + 86400000).toISOString(), status: 'pending', created_at: new Date().toISOString() } as Group);
    const base = { group_id: gid, contact: 'a@b.c', share_minor: 3000, paypal_ref: 'ORD', pay_url: 'x', refund_ref: null, paid_at: null, last_nudged_at: null };
    const stale: GroupPayment = { ...base, id: crypto.randomUUID(), friend_name: 'A', public_token: crypto.randomBytes(8).toString('hex'),
      capture_id: null, status: 'capturing', capture_started_at: ago(30 * 60_000) } as GroupPayment;
    const stuckRefund: GroupPayment = { ...base, id: crypto.randomUUID(), friend_name: 'B', public_token: crypto.randomBytes(8).toString('hex'),
      capture_id: 'CAP-STUCK', status: 'cancelled' } as GroupPayment;
    await groupsRepo.createPayments([stale, stuckRefund]);
    const r = await jobRunner.reconcileStuckWork();
    expect(r.captures).toBe(1);
    expect(r.refunds).toBe(1);
    expect((await groupsRepo.getPaymentById(stale.id))?.status).toBe('sent');
    const refunded = await groupsRepo.getPaymentById(stuckRefund.id);
    expect(refunded?.status).toBe('refunded');
    expect(refunded?.refund_ref).toBeTruthy();
  });

  it('is single-flight: a second concurrent run skips while the lease is held', async () => {
    approval({ status: 'pending', expires_at: ago(1000) });
    const [a, b] = await Promise.all([jobRunner.reconcileStuckWork(), jobRunner.reconcileStuckWork()]);
    expect(a.approvals + b.approvals).toBe(1);
  });
});
