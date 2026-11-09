import { enrollTestPin, stepUp } from './helpers/stepup.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { initLocalSeed } from '../src/core/database.js';
import { approvalsRepo } from '../src/repos/approvals.js';
import { jobRunner } from '../src/jobs/runner.js';
import { createDevToken } from '../src/core/auth.js';
import { placesService } from '../src/services/places.js';

interface ApiResponse<T> {
  ok: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
  };
}

describe('Critical Bug Bash Verification Suite (Issues 1–6)', () => {
  let server: Server;
  let baseUrl: string;
  let aaravAuthHeader: { Authorization: string; 'Content-Type': string };

  beforeAll(async () => {
    const token = await createDevToken('00000000-0000-4000-a000-000000000001', 'aarav@pocketful.demo', 'Aarav Sharma');
    aaravAuthHeader = {
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
    await enrollTestPin(baseUrl, token);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    initLocalSeed();
  });

  // Issue 1: Missing Individual Login & Auth Enforcement
  describe('Issue 1: Authentication & JWT Enforcement', () => {
    it('rejects protected routes with 401 when Authorization header is missing', async () => {
      const res = await fetch(`${baseUrl}/api/me`);
      expect(res.status).toBe(401);
      const json = (await res.json()) as ApiResponse<unknown>;
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe('UNAUTHENTICATED');
    });

    it('rejects protected routes with 401 when Bearer token is empty or invalid', async () => {
      const res = await fetch(`${baseUrl}/api/wallet`, {
        headers: { Authorization: 'Basic 1234' }
      });
      expect(res.status).toBe(401);
    });

    it('rejects legacy magic string demo_token with 401', async () => {
      const res = await fetch(`${baseUrl}/api/me`, {
        headers: { Authorization: 'Bearer demo_token' }
      });
      expect(res.status).toBe(401);
      const json = (await res.json()) as ApiResponse<unknown>;
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe('UNAUTHENTICATED');
    });

    it('rejects unverified or unsigned base64 JWT with 401', async () => {
      const customUserId = '11111111-2222-4000-a000-333333333333';
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64');
      const payload = Buffer.from(
        JSON.stringify({
          sub: customUserId,
          email: 'custom@example.com',
          user_metadata: { name: 'Forged Tester' }
        })
      ).toString('base64');
      const forgedToken = `${header}.${payload}.`;

      const res = await fetch(`${baseUrl}/api/me`, {
        headers: {
          Authorization: `Bearer ${forgedToken}`,
          'Content-Type': 'application/json'
        }
      });
      expect(res.status).toBe(401);
      const json = (await res.json()) as ApiResponse<unknown>;
      expect(json.ok).toBe(false);
    });

    it('authenticates a custom user via properly signed JWT', async () => {
      const customUserId = '11111111-2222-4000-a000-333333333333';
      const customToken = await createDevToken(customUserId, 'custom@example.com', 'Custom Tester');

      const res = await fetch(`${baseUrl}/api/me`, {
        headers: {
          Authorization: `Bearer ${customToken}`,
          'Content-Type': 'application/json'
        }
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<{ profile: { id: string; name: string } }>;
      expect(json.ok).toBe(true);
      expect(json.data.profile.id).toBe(customUserId);
      expect(json.data.profile.name).toBe('Custom Tester');
    });
  });

  // Issue 2: Custom Split & Group Outings
  describe('Issue 2: Custom Split & Send/Receive Outing Requests', () => {
    it('creates a custom bill split validating exact amounts and listing active outings', async () => {
      const splitPayload = {
        totalMinor: 10000, // $100.00
        splitMode: 'custom',
        friends: [
          { name: 'Riya', contact: 'riya@example.com', shareMinor: 3500 },
          { name: 'Karan', contact: 'karan@example.com', shareMinor: 3500 }
        ]
        // Organizer pays remainder: 10000 - 7000 = 3000 ($30.00)
      };

      const createRes = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify(splitPayload)
      });

      expect(createRes.status).toBe(200);
      const createJson = (await createRes.json()) as ApiResponse<{
        groupId: string;
        payments: unknown[];
      }>;
      expect(createJson.ok).toBe(true);
      expect(createJson.data.payments).toHaveLength(2);

      // Now query user groups
      const listRes = await fetch(`${baseUrl}/api/groups`, { headers: aaravAuthHeader });
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as ApiResponse<{
        groups: Array<{ id: string; totalMinor: number }>;
      }>;
      expect(listJson.data.groups.length).toBeGreaterThan(0);
      const created = listJson.data.groups.find((g) => g.id === createJson.data.groupId);
      expect(created).toBeDefined();
      expect(created?.totalMinor).toBe(10000);
    });

    it('rejects custom splits where friend shares exceed the overall bill', async () => {
      const invalidSplit = {
        totalMinor: 5000, // $50.00
        splitMode: 'custom',
        friends: [
          { name: 'Riya', contact: 'riya@example.com', shareMinor: 4000 },
          { name: 'Karan', contact: 'karan@example.com', shareMinor: 4000 }
        ] // 8000 > 5000
      };

      const res = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify(invalidSplit)
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiResponse<unknown>;
      expect(json.ok).toBe(false);
      expect(json.error?.message).toContain('exceeds');
    });
  });

  // Issue 3: Missing Onboarding Form (F1 Vibe Check)
  describe('Issue 3: Onboarding Vibe Check Form', () => {
    it('saves reachKm, guiltFreeCap, vibe and social preferences via POST /api/onboarding', async () => {
      const onboardingData = {
        address: 'Mission District, San Francisco',
        reachKm: 12,
        guiltFreeCapMinor: 20000, // $200.00
        interests: ['cafes', 'gaming', 'outdoors'],
        socialPref: 'social',
        vibePref: 'lively',
        optInMood: true,
        optInTracking: true
      };

      // Offline CI: never call the real Nominatim.
      const geocode = vi
        .spyOn(placesService, 'geocodeAddress')
        .mockResolvedValue({ lat: 37.7599, lng: -122.4148, displayName: 'Mission District, San Francisco, CA, USA' });
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/onboarding`, {
          method: 'POST',
          headers: aaravAuthHeader,
          body: JSON.stringify(onboardingData)
        });
        expect(geocode).toHaveBeenCalledWith('Mission District, San Francisco');
      } finally {
        geocode.mockRestore();
      }

      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<{
        profile: { max_distance_km: number; guilt_free_cap_minor: number };
        preferences: { interests: string[]; vibe_pref: string; social_pref: string };
      }>;
      expect(json.ok).toBe(true);
      expect(json.data.profile.max_distance_km).toBe(12);
      expect(json.data.profile.guilt_free_cap_minor).toBe(20000);
      expect(json.data.preferences.interests).toEqual(['cafes', 'gaming', 'outdoors']);
      expect(json.data.preferences.vibe_pref).toBe('lively');
      expect(json.data.preferences.social_pref).toBe('social');
    });
  });

  // Issue 4: AI Orchestrator Pip Dynamic Response
  describe('Issue 4: Pip Drawer AI Orchestrator Integration', () => {
    it('returns dynamic audit cards when user asks to audit subscriptions', async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({ message: 'Can you audit my forgotten subscriptions?' })
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<{
        reply: string;
        cards: Array<{ type: string }>;
      }>;
      expect(json.ok).toBe(true);
      expect(json.data.reply).toContain('subscriptions');
      expect(json.data.cards).toBeDefined();
      expect(json.data.cards[0]?.type).toBe('audit_summary');
    });

    it('returns dynamic plan tickets when user asks for a quiet spot', async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({ message: 'I need a quiet weekend spot under $20' })
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<{
        cards: Array<{ type: string; slots: unknown[] }>;
      }>;
      expect(json.ok).toBe(true);
      expect(json.data.cards).toBeDefined();
      expect(json.data.cards[0]?.type).toBe('plan_tickets');
      expect(json.data.cards[0]?.slots).toHaveLength(3);
    });
  });

  // Issue 5: Savings/Vault Unclear
  describe('Issue 5: Savings Vault in Wallet and Sunday Vault Decisions', () => {
    it('returns vault goal and rollover balances in GET /api/wallet', async () => {
      const res = await fetch(`${baseUrl}/api/wallet`, { headers: aaravAuthHeader });
      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<{
        vault: { goalBalanceMinor: number; rolloverBalanceMinor: number };
      }>;
      expect(json.ok).toBe(true);
      expect(json.data.vault).toBeDefined();
      expect(json.data.vault.goalBalanceMinor).toBeGreaterThanOrEqual(0);
      expect(json.data.vault.rolloverBalanceMinor).toBeGreaterThanOrEqual(0);
    });

    it('routes POST /api/vault/decide through Guardian approval and step-up seal', async () => {
      const stageRes = await fetch(`${baseUrl}/api/vault/decide`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({
          action: 'lock_in',
          amountMinor: 3500
        })
      });

      expect(stageRes.status).toBe(200);
      const stageJson = (await stageRes.json()) as ApiResponse<{
        requiresApproval: boolean;
        approval: { id: string; status: string };
      }>;
      expect(stageJson.ok).toBe(true);
      expect(stageJson.data.requiresApproval).toBe(true);
      expect(stageJson.data.approval.status).toBe('pending');
      const approvalId = stageJson.data.approval.id;

      // Unapproved: Vault is unchanged
      const walletBefore = await fetch(`${baseUrl}/api/wallet`, { headers: aaravAuthHeader });
      const walletBeforeJson = (await walletBefore.json()) as ApiResponse<{ vault: { goalBalanceMinor: number } }>;
      expect(walletBeforeJson.data.vault.goalBalanceMinor).toBe(4500);

      // Request challenge nonce
      const challengeRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/challenge`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      expect(challengeRes.status).toBe(200);
      const challengeJson = (await challengeRes.json()) as ApiResponse<{ challengeNonce: string; boundHash: string }>;
      expect(challengeJson.data.challengeNonce).toBeDefined();

      // Submit decision with proof and Idempotency-Key
      const decideRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/decide`, {
        method: 'POST',
        headers: {
          ...aaravAuthHeader,
          'Idempotency-Key': `idemp-vault-decide-${Date.now()}`
        },
        body: JSON.stringify({
          decision: 'approve',
          ...stepUp(challengeJson.data)
        })
      });

      expect(decideRes.status).toBe(200);
      const decideJson = (await decideRes.json()) as ApiResponse<{ status: string }>;
      expect(decideJson.ok).toBe(true);
      expect(decideJson.data.status).toBe('executed');

      // Verify that wallet reflects updated vault (initial seeded 4500 + 3500 = 8000)
      const walletRes = await fetch(`${baseUrl}/api/wallet`, { headers: aaravAuthHeader });
      const walletJson = (await walletRes.json()) as ApiResponse<{
        vault: { goalBalanceMinor: number };
      }>;
      expect(walletJson.data.vault.goalBalanceMinor).toBe(8000);
    });
  });

  // Issue 6: Unauthorized Pay on Behalf Lockdown
  describe('Issue 6: Friend Checkout Security & Public Link Access', () => {
    it('allows public checkout access on /pay/:token without organizer authorization', async () => {
      // 1. Create a group
      const groupRes = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({
          totalMinor: 5000,
          splitMode: 'equal',
          friends: [{ name: 'Ananya', contact: 'ananya@example.com' }]
        })
      });

      const groupJson = (await groupRes.json()) as ApiResponse<{
        groupId: string;
        approvalId: string;
        payments: Array<{ public_token: string }>;
      }>;
      const token = groupJson.data.payments[0]?.public_token;
      expect(token).toBeDefined();

      // 1b. Organizer approves sending requests
      const sendChal = await fetch(`${baseUrl}/api/approvals/${groupJson.data.approvalId}/challenge`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      const sendChalJson = (await sendChal.json()) as ApiResponse<{ challengeNonce: string; boundHash: string }>;
      await fetch(`${baseUrl}/api/approvals/${groupJson.data.approvalId}/decide`, {
        method: 'POST',
        headers: { ...aaravAuthHeader, 'Idempotency-Key': `send_req_issue6_${Date.now()}` },
        body: JSON.stringify({ decision: 'approve', ...stepUp(sendChalJson.data) })
      });

      // 2. Unauthenticated friend visits /pay/:token
      const friendPageRes = await fetch(`${baseUrl}/pay/${token}`);
      expect(friendPageRes.status).toBe(200);
      const friendPageJson = (await friendPageRes.json()) as ApiResponse<{
        friendName: string;
      }>;
      expect(friendPageJson.ok).toBe(true);
      expect(friendPageJson.data.friendName).toBe('Ananya');

      // 3. Friend captures their own share
      const captureRes = await fetch(`${baseUrl}/pay/${token}/capture`, {
        method: 'POST'
      });
      expect(captureRes.status).toBe(200);
      const captureJson = (await captureRes.json()) as ApiResponse<{
        payment: { status: string };
      }>;
      expect(captureJson.ok).toBe(true);
      expect(captureJson.data.payment.status).toBe('paid');
    });
  });

  // Issue 7: Group Refund Execution & Approval Expiry Enforcement
  describe('Issue 7: Group Refund Execution & Approval Expiry Enforcement', () => {
    it('stages and executes refund for an outing, refunding paid friends', async () => {
      // 1. Create a group
      const groupRes = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({
          totalMinor: 6000,
          splitMode: 'equal',
          friends: [{ name: 'Deepa', contact: 'deepa@example.com' }]
        })
      });
      const groupJson = (await groupRes.json()) as ApiResponse<{
        groupId: string;
        approvalId: string;
        payments: Array<{ public_token: string }>;
      }>;
      const groupId = groupJson.data.groupId;
      const token = groupJson.data.payments[0]!.public_token;

      // 1b. Organizer approves sending requests
      const sendChal = await fetch(`${baseUrl}/api/approvals/${groupJson.data.approvalId}/challenge`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      const sendChalJson = (await sendChal.json()) as ApiResponse<{ challengeNonce: string; boundHash: string }>;
      await fetch(`${baseUrl}/api/approvals/${groupJson.data.approvalId}/decide`, {
        method: 'POST',
        headers: { ...aaravAuthHeader, 'Idempotency-Key': `send_req_refund_${Date.now()}` },
        body: JSON.stringify({ decision: 'approve', ...stepUp(sendChalJson.data) })
      });

      // 2. Friend pays
      await fetch(`${baseUrl}/pay/${token}/capture`, { method: 'POST' });

      // 3. Organizer cancels the group and stages refund
      const cancelRes = await fetch(`${baseUrl}/api/groups/${groupId}/cancel`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      expect(cancelRes.status).toBe(200);
      const cancelJson = (await cancelRes.json()) as ApiResponse<{
        approvalId: string;
        status: string;
      }>;
      expect(cancelJson.ok).toBe(true);
      expect(cancelJson.data.approvalId).toBeDefined();

      // 4. Organizer requests challenge and approves the refund
      const chalRes = await fetch(`${baseUrl}/api/approvals/${cancelJson.data.approvalId}/challenge`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      const chalJson = (await chalRes.json()) as ApiResponse<{ challengeNonce: string; boundHash: string }>;

      const refundExecRes = await fetch(`${baseUrl}/api/approvals/${cancelJson.data.approvalId}/decide`, {
        method: 'POST',
        headers: {
          ...aaravAuthHeader,
          'Idempotency-Key': `refund_seal_${Date.now()}`
        },
        body: JSON.stringify({
          decision: 'approve',
          ...stepUp(chalJson.data)
        })
      });
      expect(refundExecRes.status).toBe(200);
      const refundExecJson = (await refundExecRes.json()) as ApiResponse<{
        status: string;
        result: { refundedCount: number; totalRefundMinor: number };
      }>;
      expect(refundExecJson.ok).toBe(true);
      expect(refundExecJson.data.status).toBe('executed');
      expect(refundExecJson.data.result.refundedCount).toBe(1);

      // 5. Verify group is marked as refunded
      const refreshedRes = await fetch(`${baseUrl}/api/groups/${groupId}`, { headers: aaravAuthHeader });
      const refreshedJson = (await refreshedRes.json()) as ApiResponse<{
        group: { status: string };
        payments: Array<{ status: string }>;
      }>;
      expect(refreshedJson.data.group.status).toBe('refunded');
      expect(refreshedJson.data.payments[0]?.status).toBe('refunded');
    });

    it('rejects approval decision with 410 when approval window has expired', async () => {
      // Create a test approval that expired 5 minutes ago
      const expiredApproval = await approvalsRepo.create({
        id: '99999999-9999-4999-a999-999999999999',
        user_id: '00000000-0000-4000-a000-000000000001',
        action_type: 'reset_learning',
        payload: {},
        preview: 'Expired action',
        amount_minor: 0,
        status: 'pending',
        idempotency_key: `expired_key_${Date.now()}`,
        result: null,
        expires_at: new Date(Date.now() - 5 * 60 * 1000).toISOString()
      });

      const res = await fetch(`${baseUrl}/api/approvals/${expiredApproval.id}/decide`, {
        method: 'POST',
        headers: {
          ...aaravAuthHeader,
          'Idempotency-Key': `decide_expired_${Date.now()}`
        },
        body: JSON.stringify({ decision: 'approve' })
      });
      expect(res.status).toBe(410);
      const json = (await res.json()) as ApiResponse<unknown>;
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe('APPROVAL_EXPIRED');
    });

    it('rejects approval decision with 400 when approval was already denied', async () => {
      const deniedApproval = await approvalsRepo.create({
        id: '88888888-8888-4888-a888-888888888888',
        user_id: '00000000-0000-4000-a000-000000000001',
        action_type: 'reset_learning',
        payload: {},
        preview: 'Denied action',
        amount_minor: 0,
        status: 'denied',
        idempotency_key: `denied_key_${Date.now()}`,
        result: null,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      });

      const res = await fetch(`${baseUrl}/api/approvals/${deniedApproval.id}/decide`, {
        method: 'POST',
        headers: {
          ...aaravAuthHeader,
          'Idempotency-Key': `decide_denied_${Date.now()}`
        },
        body: JSON.stringify({ decision: 'approve' })
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ApiResponse<unknown>;
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe('VALIDATION_FAILED');
    });
  });

  // Issue 8: Mood Persistence & Automatic Plan Mood Inheritance
  describe('Issue 8: Mood Persistence & Automatic Plan Mood Inheritance', () => {
    it('persists mood checkin and auto-inherits mood in subsequent plan generation', async () => {
      // 1. Post mood checkin
      const moodRes = await fetch(`${baseUrl}/api/mood`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({ level: 'drained' })
      });
      expect(moodRes.status).toBe(200);
      const moodJson = (await moodRes.json()) as ApiResponse<{ mood: string; saved: boolean }>;
      expect(moodJson.data.mood).toBe('drained');
      expect(moodJson.data.saved).toBe(true);

      // 2. Request plan without explicit mood parameter
      const planRes = await fetch(`${baseUrl}/api/plans`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({ groupSize: 1 })
      });
      expect(planRes.status).toBe(200);
      const planJson = (await planRes.json()) as ApiResponse<{ mood: string }>;
      expect(planJson.data.mood).toBe('drained');
    });
  });

  // Issue 9: Background Payment Deadline Checks
  describe('Issue 9: Background Payment Deadline Checks', () => {
    it('automatically checks and cancels expired pending outings without payments', async () => {
      // 1. Create a group
      const groupRes = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({
          totalMinor: 4000,
          splitMode: 'equal',
          friends: [{ name: 'Siddharth', contact: 'sid@example.com' }]
        })
      });
      const groupJson = (await groupRes.json()) as ApiResponse<{ groupId: string }>;
      const groupId = groupJson.data.groupId;

      // 2. Fast-forward deadline into the past
      const { localDb } = await import('../src/core/database.js');
      const g = localDb.groups.get(groupId);
      if (g) {
        g.deadline = new Date(Date.now() - 3600000).toISOString();
        g.status = 'pending';
        localDb.groups.set(groupId, g);
      }

      // 3. Trigger deadline checker
      const handled = await jobRunner.checkDeadlines('00000000-0000-4000-a000-000000000001');
      expect(handled).toBeGreaterThanOrEqual(1);

      // 4. Verify group was marked cancelled
      const checkGroup = localDb.groups.get(groupId);
      expect(checkGroup?.status).toBe('cancelled');
    });
  });

  // Issue 10: Concurrency Race & In-Flight Locking on /api/approvals/:id/decide
  describe('Issue 10: In-Flight Concurrency Guard on Financial Decisions', () => {
    it('blocks concurrent requests on the same pending approval with 409 Conflict', async () => {
      const { localDb } = await import('../src/core/database.js');
      localDb.subscriptions.set('sub_concurrent_test', {
        id: 'sub_concurrent_test',
        user_id: '00000000-0000-4000-a000-000000000001',
        merchant: 'Concurrent Cloud Pass',
        amount_minor: 3500,
        interval: 'monthly',
        paypal_subscription_id: 'I-DEMO-CONCURRENT-001',
        status: 'active',
        last_used_signal: null,
        flagged_ghost: true,
        ghost_reason: 'Unused',
        ghost_snoozed_until: null
      });

      // Create a pending test approval
      const testApproval = await approvalsRepo.create({
        id: '77777777-7777-4777-a777-777777777777',
        user_id: '00000000-0000-4000-a000-000000000001',
        action_type: 'cancel_subscription',
        payload: { subscriptionIds: ['sub_concurrent_test'] },
        preview: 'Cancel Concurrent Cloud Pass',
        amount_minor: 3500,
        status: 'pending',
        idempotency_key: `concurrent_test_${Date.now()}`,
        result: null,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      });

      // Request challenge nonce
      const chalRes = await fetch(`${baseUrl}/api/approvals/${testApproval.id}/challenge`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      const chalJson = (await chalRes.json()) as ApiResponse<{ challengeNonce: string; boundHash: string }>;
      const validProof = stepUp(chalJson.data);
      const winningKey = `key_a_${Date.now()}`;

      // Fire two simultaneous requests
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/approvals/${testApproval.id}/decide`, {
          method: 'POST',
          headers: {
            ...aaravAuthHeader,
            'Idempotency-Key': winningKey
          },
          body: JSON.stringify({ decision: 'approve', ...validProof })
        }),
        fetch(`${baseUrl}/api/approvals/${testApproval.id}/decide`, {
          method: 'POST',
          headers: {
            ...aaravAuthHeader,
            'Idempotency-Key': `key_b_${Date.now()}`
          },
          body: JSON.stringify({ decision: 'approve', ...validProof })
        })
      ]);

      const statuses = [res1.status, res2.status];
      // Exactly one must succeed (200) and the concurrent one must be blocked with 409 Conflict
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);

      // Subsequent replayed request with winning key returns 200 with replayed: true
      const replayRes = await fetch(`${baseUrl}/api/approvals/${testApproval.id}/decide`, {
        method: 'POST',
        headers: {
          ...aaravAuthHeader,
          'Idempotency-Key': winningKey
        },
        body: JSON.stringify({ decision: 'approve' })
      });
      expect(replayRes.status).toBe(200);
      const replayJson = (await replayRes.json()) as ApiResponse<{ replayed?: boolean; status: string }>;
      expect(replayJson.data.replayed).toBe(true);
      expect(replayJson.data.status).toBe('executed');
    });
  });

  // Issue 11: reset_learning Updates Status to Executed and Logs Audit
  describe('Issue 11: reset_learning Execution & Audit Log', () => {
    it('executes reset_learning via Guardian, transitions status to executed, and resets bandit', async () => {
      const resetApproval = await approvalsRepo.create({
        id: '66666666-6666-4666-a666-666666666666',
        user_id: '00000000-0000-4000-a000-000000000001',
        action_type: 'reset_learning',
        payload: {},
        preview: 'Reset learning profile',
        amount_minor: 0,
        status: 'pending',
        idempotency_key: `reset_action_${Date.now()}`,
        result: null,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      });

      const chalRes = await fetch(`${baseUrl}/api/approvals/${resetApproval.id}/challenge`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      const chalJson = (await chalRes.json()) as ApiResponse<{ challengeNonce: string; boundHash: string }>;

      const res = await fetch(`${baseUrl}/api/approvals/${resetApproval.id}/decide`, {
        method: 'POST',
        headers: {
          ...aaravAuthHeader,
          'Idempotency-Key': `exec_reset_${Date.now()}`
        },
        body: JSON.stringify({
          decision: 'approve',
          ...stepUp(chalJson.data)
        })
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<{ status: string; result: { reset: boolean } }>;
      expect(json.data.status).toBe('executed');
      expect(json.data.result.reset).toBe(true);

      // Verify approval record status in database is executed
      const updated = await approvalsRepo.getById(resetApproval.id);
      expect(updated?.status).toBe('executed');
    });
  });

  // Issue 12: Public Friend Payment Checkout Protections
  describe('Issue 12: Friend Checkout Route Safeguards', () => {
    it('rejects capture requests on cancelled group outings with 410', async () => {
      // 1. Create split
      const createRes = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({
          totalMinor: 5000,
          splitMode: 'equal',
          friends: [{ name: 'Ananya', contact: 'ananya@example.com' }]
        })
      });
      const createJson = (await createRes.json()) as ApiResponse<{
        groupId: string;
        payments: Array<{ public_token: string }>;
      }>;
      const groupId = createJson.data.groupId;
      const token = createJson.data.payments[0]?.public_token;
      expect(token).toBeDefined();

      // 2. Cancel the group outing (0 paid -> cancelled)
      const cancelRes = await fetch(`${baseUrl}/api/groups/${groupId}/cancel`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      expect(cancelRes.status).toBe(200);

      // 3. Friend attempts to pay for cancelled outing
      const payRes = await fetch(`${baseUrl}/pay/${token}/capture`, { method: 'POST' });
      expect(payRes.status).toBe(410);
      const payJson = (await payRes.json()) as ApiResponse<unknown>;
      expect(payJson.error?.code).toBe('OUTING_CANCELLED');
    });

    it('returns idempotent success when friend payment is already paid', async () => {
      // 1. Create split
      const createRes = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({
          totalMinor: 6000,
          splitMode: 'equal',
          friends: [{ name: 'Vikram', contact: 'vikram@example.com' }]
        })
      });
      const createJson = (await createRes.json()) as ApiResponse<{
        groupId: string;
        approvalId: string;
        payments: Array<{ public_token: string }>;
      }>;
      const token = createJson.data.payments[0]?.public_token;

      // 1b. Organizer approves sending requests
      const sendChal = await fetch(`${baseUrl}/api/approvals/${createJson.data.approvalId}/challenge`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      const sendChalJson = (await sendChal.json()) as ApiResponse<{ challengeNonce: string; boundHash: string }>;
      await fetch(`${baseUrl}/api/approvals/${createJson.data.approvalId}/decide`, {
        method: 'POST',
        headers: { ...aaravAuthHeader, 'Idempotency-Key': `send_req_replay_${Date.now()}` },
        body: JSON.stringify({ decision: 'approve', ...stepUp(sendChalJson.data) })
      });

      // 2. First capture succeeds
      const firstPay = await fetch(`${baseUrl}/pay/${token}/capture`, { method: 'POST' });
      expect(firstPay.status).toBe(200);

      // 3. Second capture returns replayed idempotent success
      const secondPay = await fetch(`${baseUrl}/pay/${token}/capture`, { method: 'POST' });
      expect(secondPay.status).toBe(200);
      const secondJson = (await secondPay.json()) as ApiResponse<{ replayed?: boolean; message: string }>;
      expect(secondJson.data.replayed).toBe(true);
    });
  });

  // Issue 13: Group Outing Cancellation Without Paid Friends
  describe('Issue 13: Direct Group Outing Cancellation', () => {
    it('cancels group outing directly without phantom $0 approval when no friends have paid', async () => {
      const createRes = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({
          totalMinor: 8000,
          splitMode: 'equal',
          friends: [{ name: 'Pooja', contact: 'pooja@example.com' }]
        })
      });
      const createJson = (await createRes.json()) as ApiResponse<{ groupId: string }>;
      const groupId = createJson.data.groupId;

      // Cancel before anyone pays
      const cancelRes = await fetch(`${baseUrl}/api/groups/${groupId}/cancel`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      expect(cancelRes.status).toBe(200);
      const cancelJson = (await cancelRes.json()) as ApiResponse<{ status: string; approvalId?: string }>;
      expect(cancelJson.data.status).toBe('cancelled');
      expect(cancelJson.data.approvalId).toBeUndefined();

      // Verify group in DB is cancelled
      const getRes = await fetch(`${baseUrl}/api/groups/${groupId}`, { headers: aaravAuthHeader });
      const getJson = (await getRes.json()) as ApiResponse<{ group: { status: string } }>;
      expect(getJson.data.group.status).toBe('cancelled');
    });
  });

  // Issue 14: PayPal Webhook Subscriptions Lookup
  describe('Issue 14: PayPal Webhook Subscription Resolution', () => {
    it('finds and cancels subscription by paypal_subscription_id without hardcoded user ID', async () => {
      const { localDb } = await import('../src/core/database.js');
      const testSubId = 'sub_custom_user_99';
      const customUserId = '22222222-3333-4000-a000-444444444444';
      const paypalSubId = 'I-CUSTOM-PAYPAL-999';

      localDb.subscriptions.set(testSubId, {
        id: testSubId,
        user_id: customUserId,
        merchant: 'SaaS Pro Tool',
        amount_minor: 2900,
        interval: 'monthly',
        paypal_subscription_id: paypalSubId,
        status: 'active',
        last_used_signal: null,
        flagged_ghost: false,
        ghost_reason: null,
        ghost_snoozed_until: null
      });

      // Send webhook for this custom user's subscription
      const webhookPayload = {
        id: `WH-TEST-${Date.now()}`,
        event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
        resource: { id: paypalSubId }
      };

      const whRes = await fetch(`${baseUrl}/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload)
      });

      expect(whRes.status).toBe(200);

      // Verify the custom user's subscription was cancelled
      const updated = localDb.subscriptions.get(testSubId);
      expect(updated?.status).toBe('cancelled');
    });
  });

  // Issue 15: Subscription Snooze Authorization
  describe('Issue 15: Subscription Snooze Authorization Guard', () => {
    it('rejects snooze attempts on subscriptions belonging to another user with 404', async () => {
      const { localDb } = await import('../src/core/database.js');
      const otherUserId = '99999999-9999-4999-a999-999999999999';
      const otherSubId = 'sub_other_user_1';

      localDb.subscriptions.set(otherSubId, {
        id: otherSubId,
        user_id: otherUserId,
        merchant: 'Private Vault',
        amount_minor: 1500,
        interval: 'monthly',
        paypal_subscription_id: 'I-OTHER-001',
        status: 'active',
        last_used_signal: null,
        flagged_ghost: true,
        ghost_reason: 'Unused',
        ghost_snoozed_until: null
      });

      // Aarav attempts to snooze other user's subscription
      const res = await fetch(`${baseUrl}/api/subscriptions/${otherSubId}/snooze`, {
        method: 'POST',
        headers: aaravAuthHeader
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ApiResponse<unknown>;
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe('NOT_FOUND');
    });
  });

  // Issue 16: PayPal Webhook Empty & Malformed Payload Handling
  describe('Issue 16: Webhook Resiliency Against Empty or Malformed Payloads', () => {
    it('returns 400 Bad Request when receiving empty body without 500 error', async () => {
      const res = await fetch(`${baseUrl}/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: ''
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 Bad Request when receiving malformed JSON', async () => {
      const res = await fetch(`${baseUrl}/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ malformed json: not valid'
      });

      expect(res.status).toBe(400);
    });
  });

  // Issue 17: Automatic Cancellation of Unpaid Payments on Refund or Deadline Expiry
  describe('Issue 17: Unpaid Payment Cancellation on Refund or Deadline Expiry', () => {
    it('marks unpaid payments as cancelled when executing group refund', async () => {
      const { groupsRepo } = await import('../src/repos/groups.js');
      const { splitterAgent } = await import('../src/agents/splitter.js');

      // Create a split with 2 friends
      const split = await splitterAgent.createGroupSplit('00000000-0000-4000-a000-000000000001', {
        totalMinor: 6000,
        splitMode: 'equal',
        friends: [
          { name: 'Friend Paid', contact: 'paid@example.com' },
          { name: 'Friend Unpaid', contact: 'unpaid@example.com' }
        ]
      });

      const payments = await groupsRepo.getPaymentsByGroupId(split.group.id);
      const paidP = payments[0]!;
      const unpaidP = payments[1]!;

      // Mark one payment as paid with capture ID
      await groupsRepo.updatePaymentStatus(paidP.id, 'paid', 'CAP-DEMO-REFUND-1', new Date().toISOString());

      // Stage refund
      const approval = await splitterAgent.stageGroupRefund(split.group.id, '00000000-0000-4000-a000-000000000001');

      // Request challenge and execute refund
      const chalRes = await fetch(`${baseUrl}/api/approvals/${approval.id}/challenge`, {
        method: 'POST',
        headers: aaravAuthHeader
      });
      const chalJson = (await chalRes.json()) as ApiResponse<{ challengeNonce: string; boundHash: string }>;

      await fetch(`${baseUrl}/api/approvals/${approval.id}/decide`, {
        method: 'POST',
        headers: {
          ...aaravAuthHeader,
          'Idempotency-Key': `refund_exec_${Date.now()}`
        },
        body: JSON.stringify({
          decision: 'approve',
          ...stepUp(chalJson.data)
        })
      });

      // Check payments status
      const updatedPaid = await groupsRepo.getPaymentById(paidP.id);
      const updatedUnpaid = await groupsRepo.getPaymentById(unpaidP.id);
      expect(updatedPaid?.status).toBe('refunded');
      expect(updatedUnpaid?.status).toBe('cancelled');
    });

    it('marks unpaid payments as cancelled when deadline expires without payments', async () => {
      const { groupsRepo } = await import('../src/repos/groups.js');
      const { splitterAgent } = await import('../src/agents/splitter.js');

      const split = await splitterAgent.createGroupSplit('00000000-0000-4000-a000-000000000001', {
        totalMinor: 5000,
        splitMode: 'equal',
        friends: [{ name: 'Friend Expired', contact: 'expired@example.com' }],
        deadlineHours: 1
      });

      // Set deadline to past and status to pending
      const group = await groupsRepo.getGroupById(split.group.id);
      if (group) {
        group.status = 'pending';
        group.deadline = new Date(Date.now() - 3600000).toISOString();
      }

      await jobRunner.checkDeadlines('00000000-0000-4000-a000-000000000001');

      const payments = await groupsRepo.getPaymentsByGroupId(split.group.id);
      expect(payments[0]?.status).toBe('cancelled');
    });
  });

  // Issue 18: Manual Tracker Preserves User Currency
  describe('Issue 18: Manual Leisure Transaction Currency Preservation', () => {
    it('sets transaction currency according to user profile currency', async () => {
      const res = await fetch(`${baseUrl}/api/tracker/manual`, {
        method: 'POST',
        headers: aaravAuthHeader,
        body: JSON.stringify({
          merchantName: 'Aarav Tea Roastery',
          amountMinor: 1200,
          category: 'cafes'
        })
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ApiResponse<{ transaction: { currency: string } }>;
      expect(json.data.transaction.currency).toBe('USD');
    });
  });
});

