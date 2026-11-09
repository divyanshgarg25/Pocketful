import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { guardianAgent, computeMoneyOutMinor, type ActionRequest } from '../src/agents/guardian.js';
import { approvalsRepo } from '../src/repos/approvals.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { auditRepo } from '../src/repos/audit.js';
import { ApprovalExpiredError, ConflictError, ForbiddenError, GuardianBlockedError, NotFoundError } from '../src/core/errors.js';
import type { Profile } from '../src/schemas/domain.js';

const userId = '00000000-0000-4000-a000-000000000001';

describe('Guardian: caps, approvals and execution safety', () => {
  let user: Profile;
  const withCaps = (per: number, weekly: number): Profile => ({ ...user, per_action_cap_minor: per, weekly_cap_minor: weekly });
  const action = (over: Partial<ActionRequest> = {}): ActionRequest => ({
    type: 'vault_move',
    amountMinor: 1500,
    payload: { n: crypto.randomUUID() },
    preview: 'Move money',
    idempotencyKey: `g_${crypto.randomUUID()}`,
    ...over
  });
  const stage = async (u: Profile, a: ActionRequest = action()) => {
    const r = await guardianAgent.requestApproval(u, a, 'req');
    if (!r.approval) throw new Error(`expected an approval, got block: ${r.blockedReason}`);
    return r.approval;
  };
  const approve = (id: string) => approvalsRepo.updateStatus(id, 'approved', undefined, userId);
  /** What the /decide route does before handing over to the Guardian: approved -> executing, atomically. */
  const begin = async (id: string) => {
    await approve(id);
    await approvalsRepo.beginExecution(id, userId, ['approved']);
  };

  beforeEach(async () => {
    initLocalSeed();
    localDb.approvals.clear();
    user = (await profilesRepo.getById(userId))!;
  });

  describe('computeMoneyOutMinor', () => {
    it('moves no money for non-money actions, and treats everything else as the full amount', () => {
      for (const t of ['cancel_subscription', 'reset_learning', 'delete_data', 'change_caps', 'change_currency'] as const) {
        expect(computeMoneyOutMinor(t, 5000), t).toBe(0);
      }
      expect(computeMoneyOutMinor('vault_move', 1234)).toBe(1234);
      expect(computeMoneyOutMinor('pocket_move', 99)).toBe(99);
    });
  });

  describe('evaluate', () => {
    it('blocks spending when the per-action or weekly cap is $0 (locked, never "unlimited")', async () => {
      expect(await guardianAgent.evaluate(withCaps(0, 50000), action())).toMatchObject({ kind: 'block', reason: expect.stringMatching(/locked/) });
      expect(await guardianAgent.evaluate(withCaps(5000, 0), action())).toMatchObject({ kind: 'block' });
    });

    it('blocks an action that alone exceeds the per-action cap', async () => {
      const r = await guardianAgent.evaluate(withCaps(1000, 50000), action({ amountMinor: 1500 }));
      expect(r).toMatchObject({ kind: 'block', reason: expect.stringMatching(/per-action safety cap of \$10\.00/) });
    });

    it('blocks an action that would push weekly money-out over the weekly cap', async () => {
      const r = await guardianAgent.evaluate(withCaps(5000, 1000), action({ amountMinor: 1500 }));
      expect(r).toMatchObject({ kind: 'block', reason: expect.stringMatching(/weekly safety cap of \$10\.00/) });
    });

    it('counts money already executed this week toward the weekly cap', async () => {
      const first = await stage(withCaps(5000, 2000), action({ amountMinor: 1500 }));
      await begin(first.id);
      await guardianAgent.executeApprovedAction(first.id, withCaps(5000, 2000), async () => ({ ok: true }));
      const r = await guardianAgent.evaluate(withCaps(5000, 2000), action({ amountMinor: 1000 }));
      expect(r).toMatchObject({ kind: 'block', reason: expect.stringMatching(/\$25\.00/) }); // 1500 + 1000
    });

    it('requires approval for money actions and allows within caps otherwise', async () => {
      expect(await guardianAgent.evaluate(withCaps(5000, 50000), action())).toMatchObject({ kind: 'needs_approval', moneyOutMinor: 1500 });
    });

    it('gives non-money actions an approval but never a cap block, even with caps at $0', async () => {
      const r = await guardianAgent.evaluate(withCaps(0, 0), action({ type: 'delete_data', amountMinor: 0 }));
      expect(r.kind).toBe('needs_approval');
    });

    it('for send_requests the per-action cap applies to the ORGANIZER share, not the whole bill', async () => {
      const big = action({ type: 'send_requests', amountMinor: 90000, payload: { organizerShareMinor: 2000 } });
      expect(await guardianAgent.evaluate(withCaps(2500, 50000), big)).toMatchObject({ kind: 'needs_approval' });
      expect(await guardianAgent.evaluate(withCaps(1500, 50000), big)).toMatchObject({ kind: 'block' });
    });
  });

  describe('requestApproval', () => {
    it('a blocked action creates NO approval and leaves an audit record with the reason', async () => {
      const u = withCaps(1000, 50000);
      const r = await guardianAgent.requestApproval(u, action({ amountMinor: 1500 }), 'req-blocked');
      expect(r.approval).toBeNull();
      expect(r.blockedReason).toMatch(/per-action safety cap/);
      expect(localDb.approvals.size).toBe(0);
      const logs = await auditRepo.getByUserId(userId);
      expect(logs.some((l) => l.action === 'blocked_vault_move' && l.request_id === 'req-blocked')).toBe(true);
    });

    it('staging the same idempotency key twice returns the SAME live approval (no duplicates)', async () => {
      const a = action({ idempotencyKey: 'same-key-aaaaaaaaaaaaaaaa' });
      const first = await stage(user, a);
      const second = await stage(user, a);
      expect(second.id).toBe(first.id);
      expect(localDb.approvals.size).toBe(1);
    });
  });

  describe('assertExecutable (re-validated at execution time)', () => {
    const base = async () => {
      const a = await stage(user);
      await approve(a.id);
      return (await approvalsRepo.getById(a.id, userId))!;
    };

    it('passes for an approved, unexpired, owned approval within caps', async () => {
      expect(() => guardianAgent.assertExecutable(base_ok(), user)).not.toThrow();
      function base_ok() { return { ...makeApproval(), status: 'approved' as const }; }
    });

    it.each(['pending', 'denied', 'expired', 'cancelled', 'executed', 'failed'] as const)('rejects status %s', async (status) => {
      const a = { ...(await base()), status };
      expect(() => guardianAgent.assertExecutable(a, user)).toThrow(ConflictError);
    });

    it('rejects an expired approval', async () => {
      const a = { ...(await base()), expires_at: new Date(Date.now() - 1000).toISOString() };
      expect(() => guardianAgent.assertExecutable(a, user)).toThrow(ApprovalExpiredError);
    });

    it("rejects someone else's approval", async () => {
      const a = await base();
      expect(() => guardianAgent.assertExecutable(a, { ...user, id: crypto.randomUUID() })).toThrow(ForbiddenError);
    });

    it('rejects if the user lowered their per-action cap after approving', async () => {
      const a = await base(); // 1500 money out
      expect(() => guardianAgent.assertExecutable(a, withCaps(1000, 50000))).toThrow(GuardianBlockedError);
    });

    function makeApproval() {
      return { id: 'x', user_id: userId, status: 'approved', expires_at: new Date(Date.now() + 60_000).toISOString(), money_out_minor: 100 } as never;
    }
  });

  describe('executeApprovedAction', () => {
    it('refuses an unknown approval id', async () => {
      await expect(guardianAgent.executeApprovedAction(crypto.randomUUID(), user, async () => 1)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('runs the executor once, records the outcome, and marks the approval executed with an audit trail', async () => {
      const a = await stage(user);
      await begin(a.id);
      let calls = 0;
      const out = await guardianAgent.executeApprovedAction(a.id, user, async () => { calls++; return { moved: 1500 }; }, 'req-x');
      expect(calls).toBe(1);
      expect(out.approval.status).toBe('executed');
      expect(out.result).toEqual({ moved: 1500 });
      const logs = (await auditRepo.getByUserId(userId)).map((l) => l.action);
      expect(logs).toEqual(expect.arrayContaining(['execution_intent_vault_move']));
    });

    it('a failing executor marks the approval FAILED (retryable) and audits the failure', async () => {
      const a = await stage(user);
      await begin(a.id);
      await expect(guardianAgent.executeApprovedAction(a.id, user, async () => { throw new Error('paypal down'); })).rejects.toThrow('paypal down');
      expect((await approvalsRepo.getById(a.id, userId))?.status).toBe('failed');
      const logs = (await auditRepo.getByUserId(userId)).filter((l) => l.approval_id === a.id).map((l) => l.action);
      expect(logs).toContain('execution_failed_vault_move');
    });

    it('once the side effect HAS happened the approval never becomes failed (a retry would move the money twice)', async () => {
      const a = await stage(user);
      await begin(a.id);
      let calls = 0;
      await expect(
        guardianAgent.executeApprovedAction(a.id, user, async () => {
          calls++;
          // Something else (e.g. the user denying it in another tab) changes the approval mid-execution.
          localDb.approvals.get(a.id)!.status = 'denied';
          return { moved: 1500 };
        })
      ).rejects.toBeInstanceOf(ConflictError);
      expect(calls).toBe(1);
      const after = (await approvalsRepo.getById(a.id, userId))!;
      expect(after.status).not.toBe('failed');
      // Audited as a bookkeeping problem for the reconciler, never as an execution failure.
      const mine = (await auditRepo.getByUserId(userId)).filter((l) => l.approval_id === a.id).map((l) => l.action);
      expect(mine).toContain('execution_bookkeeping_failed_vault_move');
      expect(mine.some((x) => x.startsWith('execution_failed_'))).toBe(false);
    });

    it('re-checks the cap at execution time: a lowered cap blocks execution and the executor never runs', async () => {
      const a = await stage(user);
      await begin(a.id);
      let calls = 0;
      await expect(guardianAgent.executeApprovedAction(a.id, withCaps(1000, 50000), async () => { calls++; })).rejects.toBeInstanceOf(GuardianBlockedError);
      expect(calls).toBe(0);
    });
  });
});
