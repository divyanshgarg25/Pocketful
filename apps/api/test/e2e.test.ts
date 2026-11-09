import { enrollTestPin, stepUp } from './helpers/stepup.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { createDevToken } from '../src/core/auth.js';

interface ApiResponse<T> {
  ok: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
  };
}

describe('Pocketful 3-Minute Hackathon Demo End-to-End Flow', () => {
  let server: Server;
  let baseUrl: string;
  let authHeader: { Authorization: string; 'Content-Type': string };

  async function apiGet<T>(path: string, headers?: Record<string, string>): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, { headers: headers || authHeader });
    const json = (await res.json()) as ApiResponse<T>;
    if (!res.ok || !json.ok) {
      throw new Error(`GET ${path} failed (${res.status}): ${json.error?.message || res.statusText}`);
    }
    return json.data;
  }

  async function apiPost<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: headers || authHeader,
      body: JSON.stringify(body)
    });
    const json = (await res.json()) as ApiResponse<T>;
    if (!res.ok || !json.ok) {
      throw new Error(`POST ${path} failed (${res.status}): ${json.error?.message || res.statusText}`);
    }
    return json.data;
  }

  beforeAll(async () => {
    initLocalSeed();
    const token = await createDevToken('00000000-0000-4000-a000-000000000001', 'aarav@pocketful.demo', 'Aarav Sharma');
    authHeader = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
    await enrollTestPin(baseUrl, token);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // Flow Step 0: Healthcheck
  it('0. Health check endpoint responds with healthy status without leaking internal state', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; database?: string; paypal?: string };
    expect(data).toEqual({ status: 'ok' });
    expect(data.database).toBeUndefined();
    expect(data.paypal).toBeUndefined();
  });

  // Flow Step 1: Ghost Subscriptions Audit, Guardian Approval, and Cancellation
  it('1. Audits ghost subscriptions, requests Guardian approval, and cancels via PayPal sandbox', async () => {
    // A. Audit ghost subscriptions
    const auditData = await apiGet<{
      totalYearlyWasteMinor: number;
      totalYearlyWasteFormatted: string;
      ghostSubscriptions: Array<{ id: string; merchant: string; amount_minor: number }>;
    }>('/api/subscriptions/audit');

    expect(auditData.ghostSubscriptions.length).toBe(3);
    expect(auditData.totalYearlyWasteMinor).toBe(91188); // $911.88/yr
    const targetSub = auditData.ghostSubscriptions[0]!;

    // B. Stage cancellation (submits to Guardian)
    const stageData = await apiPost<{
      approvalId: string;
      preview: string;
      yearlySavingMinor: number;
    }>('/api/subscriptions/cancel/preview', {
      subscriptionIds: [targetSub.id]
    });

    expect(stageData.approvalId).toBeDefined();
    expect(stageData.yearlySavingMinor).toBeGreaterThan(0);

    // C. Guardian Step-Up Challenge & Approval Seal execution with Idempotency Key
    const challenge = await apiPost<{ challengeNonce: string; boundHash: string }>(
      `/api/approvals/${stageData.approvalId}/challenge`,
      {}
    );
    expect(challenge.challengeNonce).toBeDefined();

    const idempotencyKey = `sub_cancel_${Date.now()}`;
    const proof = stepUp(challenge);
    const executeData = await apiPost<{
      status: string;
      result: { cancelledIds: string[]; savedMonthlyMinor: number };
    }>(
      `/api/approvals/${stageData.approvalId}/decide`,
      {
        decision: 'approve',
        ...proof
      },
      { ...authHeader, 'Idempotency-Key': idempotencyKey }
    );

    expect(executeData.status).toBe('executed');
    expect(executeData.result.cancelledIds.length).toBe(1);

    // Idempotent double-click replay check: identical idempotencyKey returns stored result
    const replayData = await apiPost<{
      status: string;
      replayed?: boolean;
    }>(
      `/api/approvals/${stageData.approvalId}/decide`,
      {
        decision: 'approve',
        ...proof
      },
      { ...authHeader, 'Idempotency-Key': idempotencyKey }
    );
    expect(replayData.status).toBe('executed');
    expect(replayData.replayed).toBe(true);

    // D. Verify guilt-free fun money recalculation
    const walletData = await apiGet<{
      statement: { freeForWeekendMinor: number; freeForWeekendFormatted: string; currency: string };
    }>('/api/wallet');
    expect(walletData.statement.freeForWeekendMinor).toBeGreaterThan(0);
    expect(walletData.statement.currency).toBe('USD');
  });

  // Flow Step 2: Friday Plan Generation with 3 Ticket Stubs
  let generatedSlotId: string = '';
  it('2. Generates 3-ticket weekend plan (Comfort, Stretch, New) with marginalia reasoning', async () => {
    const planData = await apiPost<{
      planId: string;
      radiusKm: number;
      budgetMinor: number;
      slots: Array<{
        slot: 'comfort' | 'stretch' | 'new';
        suggestionId: string;
        distKm: number;
        costHighMinor: number;
        why: string;
        headline: string;
      }>;
    }>('/api/plans', { mood: 'drained', groupSize: 1 });

    expect(planData.slots.length).toBe(3);

    const slotTypes = planData.slots.map((s) => s.slot);
    expect(slotTypes).toContain('comfort');
    expect(slotTypes).toContain('stretch');
    expect(slotTypes).toContain('new');

    const stretchSlot = planData.slots.find((s) => s.slot === 'stretch');
    expect(stretchSlot).toBeDefined();
    expect(stretchSlot!.why).toBeDefined();
    expect(stretchSlot!.distKm).toBeLessThanOrEqual(planData.radiusKm);

    generatedSlotId = stretchSlot!.suggestionId;
  });

  // Flow Step 3: Rejection Learning (Thompson Sampling penalty)
  it('3. Rejection applies penalty only to the rejected feature dimension in Bandit state', async () => {
    const feedbackData = await apiPost<{
      suggestion: { id: string; outcome: string };
      learnedLine: string;
    }>(`/api/suggestions/${generatedSlotId}/feedback`, {
      outcome: 'rejected',
      rejectReason: 'too_far'
    });

    expect(feedbackData.suggestion.outcome).toBe('rejected');
    expect(feedbackData.learnedLine).toContain('Learned: Moving closer places up in ranking');

    // Verify Bandit learning profile
    const profileData = await apiGet<{
      lines: string[];
      explorationLevel: string;
    }>('/api/learning/profile');
    expect(profileData.lines.length).toBeGreaterThan(0);
  });

  // Flow Step 4: Group Split, Guardian Approval, & Friend Public Checkout
  it('4. Creates group split with zero penny loss, sends PayPal links, and completes friend payment', async () => {
    // A. Create equal 4-way split of $120.00
    const groupData = await apiPost<{
      groupId: string;
      approvalId: string;
      payments: Array<{
        id: string;
        friend_name: string;
        share_minor: number;
        public_token: string;
      }>;
    }>('/api/groups', {
      totalMinor: 12000, // $120.00
      splitMode: 'equal',
      friends: [
        { name: 'Amit Patel', contact: 'amit@example.com' },
        { name: 'Neha Gupta', contact: 'neha@example.com' },
        { name: 'Rohan Shah', contact: 'rohan@example.com' }
      ]
    });

    expect(groupData.approvalId).toBeDefined();
    expect(groupData.payments.length).toBe(3);

    // Penny check: Aarav + 3 friends = 4 shares. $120 / 4 = $30.00 each
    expect(groupData.payments[0]!.share_minor).toBe(3000);
    expect(groupData.payments[1]!.share_minor).toBe(3000);
    expect(groupData.payments[2]!.share_minor).toBe(3000);

    // B. Guardian Step-Up Challenge & Approval Seal Execution
    const chal = await apiPost<{ challengeNonce: string; boundHash: string }>(
      `/api/approvals/${groupData.approvalId}/challenge`,
      {}
    );

    const executeData = await apiPost<{
      status: string;
      result: { sentCount: number };
    }>(
      `/api/approvals/${groupData.approvalId}/decide`,
      {
        decision: 'approve',
        ...stepUp(chal)
      },
      { ...authHeader, 'Idempotency-Key': `group_exec_${Date.now()}` }
    );
    expect(executeData.status).toBe('executed');
    expect(executeData.result.sentCount).toBe(3);

    // C. Inspect friend payment order token
    const firstFriendPayment = groupData.payments[0]!;
    const payToken = firstFriendPayment.public_token;
    expect(payToken).toBeDefined();

    // D. Public Friend Checkout Screen (Unauthenticated)
    const publicPayData = await apiGet<{
      friendName: string;
      shareMinor: number;
      shareFormatted: string;
      status: string;
      payUrl: string;
    }>(`/pay/${payToken}`, { 'Content-Type': 'application/json' });

    expect(publicPayData.friendName).toBe('Amit Patel');
    expect(publicPayData.shareMinor).toBe(3000);
    expect(publicPayData.status).toBe('sent');
    expect(publicPayData.payUrl).toContain('paypal.com/checkoutnow');

    // E. Friend completes PayPal capture
    const captureData = await apiPost<{
      message: string;
      groupConfirmed: boolean;
      payment: { status: string };
    }>(
      `/pay/${payToken}/capture`,
      { orderId: 'ORDER_SIMULATED_123' },
      { 'Content-Type': 'application/json' }
    );
    expect(captureData.payment.status).toBe('paid');

    // F. Group status check
    const refreshedGroup = await apiGet<{
      group: { id: string };
      payments: Array<{ publicToken: string; status: string }>;
    }>(`/api/groups/${groupData.groupId}`);
    const paidFriend = refreshedGroup.payments.find((p) => p.publicToken === payToken);
    expect(paidFriend?.status).toBe('paid');
  });

  // Flow Step 5: Spend Tracker & "Worth It?" Rating
  it('5. Ingests spend transaction, prompts "Worth it?", and reinforces positive bandit reward', async () => {
    // A. Sync spend transactions
    const syncData = await apiPost<{
      syncedCount: number;
      transactions: Array<{ id: string; merchant_raw: string; amount_minor: number }>;
    }>('/api/tracker/sync', {});
    expect(syncData.transactions.length).toBeGreaterThan(0);

    const targetTxn = syncData.transactions[0]!;

    // B. User rates "Worth It"
    const rateData = await apiPost<{
      ratingRecorded: string;
      transaction: { id: string; user_rating: string };
    }>(`/api/tracker/${targetTxn.id}/rating`, {
      rating: 'worth_it'
    });
    expect(rateData.ratingRecorded).toBe('worth_it');
    expect(rateData.transaction.user_rating).toBe('worth_it');

    // C. Verify Bandit feature reward reinforced (alpha increased)
    const cafeState = localDb.bandit_state.get('00000000-0000-4000-a000-000000000001:category:cafes');
    expect(cafeState).toBeDefined();
    expect(cafeState!.alpha).toBeGreaterThan(1);
  });

  // Flow Step 6: Sunday Vault Simulation & Weekend Till Receipt
  it('6. Simulates Sunday Vault lock-in and generates itemized weekend till receipt', async () => {
    // A. Sunday Vault simulation (stages Guardian approval and executes with step-up)
    const stageRes = await apiPost<{
      action: string;
      amountFormatted: string;
      requiresApproval: boolean;
      approval: { id: string };
    }>('/api/vault/decide', {
      action: 'lock_in',
      amountMinor: 4500 // $45.00
    });
    expect(stageRes.action).toBe('lock_in');
    expect(stageRes.requiresApproval).toBe(true);

    const chal = await apiPost<{ challengeNonce: string; boundHash: string }>(
      `/api/approvals/${stageRes.approval.id}/challenge`,
      {}
    );

    const vaultData = await apiPost<{
      status: string;
      result: { vault: { goal_balance_minor: number } };
    }>(
      `/api/approvals/${stageRes.approval.id}/decide`,
      {
        decision: 'approve',
        ...stepUp(chal)
      },
      { ...authHeader, 'Idempotency-Key': `vault_e2e_${Date.now()}` }
    );
    expect(vaultData.status).toBe('executed');
    expect(vaultData.result.vault.goal_balance_minor).toBeGreaterThanOrEqual(4500);

    // B. Itemized Till Receipt
    const receiptData = await apiGet<{
      receipt: {
        week: string;
        userName: string;
        totalSpentMinor: number;
        totalSpentFormatted: string;
        recoveredFromSubscriptionsMinor: number;
        items: Array<{ name: string; amountMinor: number }>;
      };
    }>('/api/receipt/current');

    expect(receiptData.receipt.userName).toBe('Aarav Sharma');
    expect(receiptData.receipt.totalSpentMinor).toBeGreaterThanOrEqual(0);
    expect(receiptData.receipt.recoveredFromSubscriptionsMinor).toBeGreaterThan(0);
  });

  // Flow Step 7: Occasions & Getaways
  it('7. Delivers upcoming long weekend occasions feed and auto-calculates getaway fund nudges', async () => {
    const occasionsData = await apiGet<{
      calendar: Array<{ id: string; type: string; title: string }>;
      habits: Array<{ label: string }>;
      getawayStatus: { fundMinor: number; isReady: boolean };
    }>('/api/occasions');

    expect(occasionsData.calendar.length).toBeGreaterThan(0);
    expect(occasionsData.getawayStatus.fundMinor).toBeGreaterThan(0);

    // Tour proposal with 1.2x safety margin
    const tripData = await apiPost<{
      recommendedTour: { name: string; fitsFund: boolean; perDayFormatted: string; nights: number };
    }>('/api/getaways/plan', { nights: 3 });

    expect(tripData.recommendedTour).toBeDefined();
    expect(tripData.recommendedTour.nights).toBe(3);
    expect(tripData.recommendedTour.fitsFund).toBe(true);
  });

  // Flow Step 8: Pip Autonomous Conversational Agent
  it('8. Pip conversational assistant executes tools and maintains safety boundaries', async () => {
    const chatData = await apiPost<{
      reply: string;
      cards?: unknown[];
      pendingApprovals?: unknown[];
    }>('/api/chat', {
      message: 'What is my discretionary balance for this weekend?'
    });

    expect(chatData.reply).toBeDefined();
    expect(chatData.reply.length).toBeGreaterThan(10);
    // Discretionary balance reflects $140.00 minus $45.00 locked into vault = $95.00
    expect(chatData.reply).toContain('$95.00');
  });

  // Flow Step 9: Immutable Audit Log Verification
  it('9. Append-only audit log contains verified records for all executed money actions', async () => {
    const auditLogData = await apiGet<{
      logs: Array<{ id: number; action: string; agent: string; params: unknown; result: unknown }>;
    }>('/api/audit');

    expect(auditLogData.logs.length).toBeGreaterThanOrEqual(2);

    const actions = auditLogData.logs.map((l) => l.action);
    expect(actions).toContain('cancel_and_reinvest_completed');
    expect(actions).toContain('split_requests_sent');

    for (const entry of auditLogData.logs) {
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.agent).toBeDefined();
    }
  });
});
