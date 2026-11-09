import { enrollTestPin, stepUp } from './helpers/stepup.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { guardianAgent } from '../src/agents/guardian.js';
import { approvalsRepo, getLocalMondayStart } from '../src/repos/approvals.js';
import { groupsRepo } from '../src/repos/groups.js';
import { splitterAgent } from '../src/agents/splitter.js';
import type { Profile } from '../src/schemas/domain.js';

interface ApiResponse<T> {
  ok: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
  };
}

describe('Phase 3: Guardian State Machine, Step-Up & Money Safety (C4, C5, C6, H1, H2)', () => {
  let server: Server;
  let baseUrl: string;
  let authHeader: { Authorization: string; 'Content-Type': string };
  const userId = '00000000-0000-4000-a000-000000000001';

  beforeAll(async () => {
    initLocalSeed();
    const token = await createDevToken(userId, 'aarav@pocketful.demo', 'Aarav Sharma');
    authHeader = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    initLocalSeed();
  });

  it('cap=0 blocks any spending action', async () => {
    const user = localDb.profiles.get(userId)!;
    const zeroCapUser: Profile = {
      ...user,
      per_action_cap_minor: 0 // Blocked
    };

    const evalResult = await guardianAgent.evaluate(zeroCapUser, {
      type: 'refund_group',
      amountMinor: 2000,
      payload: {},
      preview: 'Refund friends $20'
    });

    expect(evalResult.kind).toBe('block');
    if (evalResult.kind === 'block') {
      expect(evalResult.reason).toContain('is set to $0.00');
    }
  });

  it('allows cancellation of a $300 subscription even when per-action cap is $250 (money_out=0)', async () => {
    const user = localDb.profiles.get(userId)!;
    expect(user.per_action_cap_minor).toBe(25000); // $250.00

    const evalResult = await guardianAgent.evaluate(user, {
      type: 'cancel_subscription',
      amountMinor: 30000, // $300.00
      payload: { subscriptionIds: ['sub-300'] },
      preview: 'Cancel $300 luxury subscription'
    });

    // Cancellation saves money rather than spending money out, so money_out_minor=0
    expect(evalResult.kind).toBe('needs_approval');
  });

  it('deny then re-stage works without returning the dead approval', async () => {
    const user = localDb.profiles.get(userId)!;
    const testKey = `test_deny_restage_${Date.now()}`;

    // 1. Stage initial approval
    const { approval: staged1 } = await guardianAgent.requestApproval(user, {
      type: 'reset_learning',
      amountMinor: 0,
      payload: {},
      preview: 'Reset bandit priors',
      idempotencyKey: testKey
    });
    expect(staged1).not.toBeNull();
    expect(staged1?.status).toBe('pending');

    // 2. Deny the approval
    const denyRes = await fetch(`${baseUrl}/api/approvals/${staged1!.id}/decide`, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Idempotency-Key': `deny_key_${Date.now()}`
      },
      body: JSON.stringify({ decision: 'deny' })
    });
    expect(denyRes.status).toBe(200);

    // 3. Re-stage with the same base idempotencyKey
    const { approval: staged2 } = await guardianAgent.requestApproval(user, {
      type: 'reset_learning',
      amountMinor: 0,
      payload: {},
      preview: 'Reset bandit priors',
      idempotencyKey: testKey
    });

    expect(staged2).not.toBeNull();
    expect(staged2?.status).toBe('pending');
    expect(staged2?.id).not.toBe(staged1!.id); // Created a brand new approval!
  });

  it('rejects execution if the underlying group was cancelled after approval was staged', async () => {
    // 1. Create group split
    const split = await splitterAgent.createGroupSplit(userId, {
      totalMinor: 4000,
      splitMode: 'equal',
      friends: [{ name: 'Sam', contact: 'sam@example.com' }]
    });

    // Stage send_requests
    const { approval } = await guardianAgent.requestApproval(localDb.profiles.get(userId)!, {
      type: 'send_requests',
      amountMinor: 4000,
      payload: { groupId: split.group.id },
      preview: 'Send split requests to friends'
    });
    expect(approval).not.toBeNull();

    // 2. Cancel the group (which also voids pending approvals for it)
    await groupsRepo.updateGroupStatus(split.group.id, 'cancelled');
    await approvalsRepo.voidPendingForGroup(split.group.id);

    // 3. Trying to decide the voided/cancelled approval must fail
    const chalRes = await fetch(`${baseUrl}/api/approvals/${approval!.id}/challenge`, {
      method: 'POST',
      headers: authHeader
    });
    // Challenge fails because status is cancelled
    expect(chalRes.status).toBe(400);
  });

  it('enforces weekly cap across week boundary and ignores spend from prior weeks', async () => {
    // Current local Monday start
    const localMonday = getLocalMondayStart(new Date(), 'America/Los_Angeles');

    // Insert an approval executed 2 weeks ago for $400
    const twoWeeksAgoIso = new Date(localMonday.getTime() - 14 * 86400000).toISOString();
    localDb.approvals.set('prior-week-app-01', {
      id: 'prior-week-app-01',
      user_id: userId,
      action_type: 'refund_group',
      amount_minor: 40000,
      money_out_minor: 40000,
      payload: {},
      preview: 'Prior week refund',
      status: 'executed',
      idempotency_key: 'prior-week-key-01',
      expires_at: twoWeeksAgoIso,
      decided_at: twoWeeksAgoIso,
      executed_at: twoWeeksAgoIso
    });

    // Verify getExecutedThisWeekTotal does NOT include the $400 from 2 weeks ago
    const totalThisWeek = await approvalsRepo.getExecutedThisWeekTotal(userId, 'America/Los_Angeles');
    expect(totalThisWeek).toBe(0);

    // Insert an approval executed yesterday (after Monday) for $100
    const currentWeekIso = new Date().toISOString();
    localDb.approvals.set('current-week-app-01', {
      id: 'current-week-app-01',
      user_id: userId,
      action_type: 'refund_group',
      amount_minor: 10000,
      money_out_minor: 10000,
      payload: {},
      preview: 'Current week refund',
      status: 'executed',
      idempotency_key: 'current-week-key-01',
      expires_at: currentWeekIso,
      decided_at: currentWeekIso,
      executed_at: currentWeekIso
    });

    const totalUpdated = await approvalsRepo.getExecutedThisWeekTotal(userId, 'America/Los_Angeles');
    expect(totalUpdated).toBe(10000);
  });

  it('rejects expired approval at the TTL boundary', async () => {
    const expiredId = 'app-ttl-boundary-expired-01';
    localDb.approvals.set(expiredId, {
      id: expiredId,
      user_id: userId,
      action_type: 'reset_learning',
      payload: {},
      preview: 'TTL boundary test',
      amount_minor: 0,
      money_out_minor: 0,
      status: 'pending',
      idempotency_key: 'ttl-boundary-key-01',
      expires_at: new Date(Date.now() - 1000).toISOString() // 1 second in the past
    });

    const res = await fetch(`${baseUrl}/api/approvals/${expiredId}/decide`, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Idempotency-Key': `ttl_decide_${Date.now()}`
      },
      body: JSON.stringify({ decision: 'approve' })
    });

    expect(res.status).toBe(410);
    const json = (await res.json()) as ApiResponse<unknown>;
    expect(json.error?.code).toBe('APPROVAL_EXPIRED');
  });

  it('allows retry on failed approvals', async () => {
    const failedId = 'app-retry-test-01';
    localDb.approvals.set(failedId, {
      id: failedId,
      user_id: userId,
      action_type: 'cancel_subscription',
      payload: { subscriptionIds: [] },
      preview: 'Failed cancellation retry test',
      amount_minor: 0,
      money_out_minor: 0,
      status: 'failed',
      idempotency_key: 'failed-key-01',
      result: { error: 'Simulated network hiccup' },
      decided_at: new Date().toISOString(),
      retry_count: 0,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    });

    // Retry always needs a fresh step-up (PIN + bound nonce)
    await enrollTestPin(baseUrl, authHeader.Authorization.replace('Bearer ', ''));
    const chal = (await (await fetch(`${baseUrl}/api/approvals/${failedId}/challenge`, { method: 'POST', headers: authHeader })).json()) as ApiResponse<{ challengeNonce: string }>;
    const noProof = await fetch(`${baseUrl}/api/approvals/${failedId}/retry`, { method: 'POST', headers: authHeader, body: '{}' });
    expect(noProof.status).toBe(403);
    const retryRes = await fetch(`${baseUrl}/api/approvals/${failedId}/retry`, {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify(stepUp(chal.data))
    });
    expect(retryRes.status).toBe(200);
    const retryJson = (await retryRes.json()) as ApiResponse<{ status: string; retried: boolean }>;
    expect(retryJson.data.status).toBe('executed');
    expect(retryJson.data.retried).toBe(true);
  });
});
