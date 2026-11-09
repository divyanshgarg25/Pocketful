import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { moneyService } from '../src/services/money.js';
import { groupsRepo } from '../src/repos/groups.js';
import type { Group, GroupPayment, Suggestion, Transaction } from '../src/schemas/domain.js';

describe('Phase 4: Payments, Friend Checkout & Webhooks (C3, H4, H6)', () => {
  let server: Server;
  let baseUrl: string;
  let authHeader: { Authorization: string; 'Content-Type': string };
  const userAaravId = '00000000-0000-4000-a000-000000000001';
  const userPriyaId = '00000000-0000-4000-a000-000000000002';

  beforeAll(async () => {
    initLocalSeed();
    const token = await createDevToken(userAaravId, 'aarav@pocketful.demo', 'Aarav Sharma');
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

  describe('Property Test: splitEqual Largest-Remainder Integrity', () => {
    it('throws on non-integer or non-positive totalMinor and count', () => {
      expect(() => moneyService.splitEqual(100.5, 3)).toThrow();
      expect(() => moneyService.splitEqual(-100, 3)).toThrow();
      expect(() => moneyService.splitEqual(0, 3)).toThrow();
      expect(() => moneyService.splitEqual(100, 0)).toThrow();
      expect(() => moneyService.splitEqual(100, -2)).toThrow();
      expect(() => moneyService.splitEqual(100, 2.5)).toThrow();
    });

    it('satisfies exact conservation of minor units and max-min <= 1 across 1,000 random cases', () => {
      for (let i = 0; i < 1000; i++) {
        const count = Math.floor(Math.random() * 50) + 1; // 1 to 50
        const totalMinor = Math.floor(Math.random() * 500000) + 1; // 1 cent to $5,000.00
        const offset = Math.floor(Math.random() * 100);

        const shares = moneyService.splitEqual(totalMinor, count, offset);

        expect(shares.length).toBe(count);

        const sum = shares.reduce((acc, curr) => acc + curr, 0);
        expect(sum).toBe(totalMinor);

        const min = Math.min(...shares);
        const max = Math.max(...shares);
        expect(max - min).toBeLessThanOrEqual(1);
      }
    });

    it('rotates remainder pennies according to rotationOffset', () => {
      // 10 cents split among 3 people = 4, 3, 3 cents
      const s0 = moneyService.splitEqual(10, 3, 0);
      expect(s0).toEqual([4, 3, 3]);

      const s1 = moneyService.splitEqual(10, 3, 1);
      expect(s1).toEqual([3, 4, 3]);

      const s2 = moneyService.splitEqual(10, 3, 2);
      expect(s2).toEqual([3, 3, 4]);
    });
  });

  describe('Group Creation & Ownership Checks (POST /api/groups)', () => {
    it('rejects contact that is neither a valid email nor an E.164 phone', async () => {
      const res = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          totalMinor: 5000,
          friends: [{ name: 'Invalid Contact', contact: 'not-an-email-or-phone' }]
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.ok).toBe(false);
    });

    it('rejects friend list exceeding 20 members', async () => {
      const friends = Array.from({ length: 21 }, (_, i) => ({
        name: `Friend ${i}`,
        contact: `friend${i}@example.com`
      }));

      const res = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          totalMinor: 50000,
          friends
        })
      });

      expect(res.status).toBe(400);
    });

    it('rejects suggestionId that does not belong to the authenticated user', async () => {
      const foreignSuggestionId = '33333333-3333-4000-a000-333333333333';
      const foreignSuggestion: Suggestion = {
        id: foreignSuggestionId,
        user_id: userPriyaId, // belongs to Priya, not Aarav
        plan_id: '44444444-4444-4000-a000-444444444444',
        venue_id: '00000000-0000-4000-b000-000000000001',
        slot: 'stretch',
        features: {}
      };
      localDb.suggestions.set(foreignSuggestionId, foreignSuggestion);

      const res = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          suggestionId: foreignSuggestionId,
          totalMinor: 6000,
          friends: [{ name: 'Karan', contact: 'karan@example.com' }]
        })
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe('FORBIDDEN');
    });

    it('rejects transactionId that does not belong to the authenticated user', async () => {
      const foreignTxnId = '55555555-5555-4000-a000-555555555555';
      const foreignTxn: Transaction = {
        id: foreignTxnId,
        user_id: userPriyaId,
        source: 'paypal_sandbox',
        source_ref: 'TXN-001',
        occurred_at: new Date().toISOString(),
        amount_minor: 7500,
        currency: 'USD',
        merchant_raw: 'Dinner Venue',
        merchant_norm: 'Dinner Venue',
        needs_question: false,
        excluded: false
      };
      localDb.transactions.set(foreignTxnId, foreignTxn);

      const res = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          transactionId: foreignTxnId,
          totalMinor: 7500,
          friends: [{ name: 'Karan', contact: 'karan@example.com' }]
        })
      });

      expect(res.status).toBe(403);
    });

    it('validates custom split shares: friend share must be > 0 and sum <= totalMinor', async () => {
      // 1. Friend share 0
      const res1 = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          totalMinor: 10000,
          splitMode: 'custom',
          friends: [{ name: 'Zero Friend', contact: 'zero@example.com', shareMinor: 0 }]
        })
      });
      expect(res1.status).toBe(400);

      // 2. Sum exceeds totalMinor
      const res2 = await fetch(`${baseUrl}/api/groups`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          totalMinor: 10000,
          splitMode: 'custom',
          friends: [
            { name: 'Big Spender', contact: 'big@example.com', shareMinor: 12000 }
          ]
        })
      });
      expect(res2.status).toBe(400);
    });
  });

  describe('Public Pay Portal & Capture Flow (/pay/:token)', () => {
    let testGroup: Group;
    let testPayment: GroupPayment;

    beforeEach(async () => {
      const groupId = '66666666-6666-4000-a000-666666666666';
      const paymentId = '77777777-7777-4000-a000-777777777777';
      testGroup = {
        id: groupId,
        organizer_id: userAaravId,
        suggestion_id: null,
        transaction_id: null,
        total_minor: 6000,
        currency: 'USD',
        deadline: new Date(Date.now() + 86400000).toISOString(),
        status: 'draft',
        created_at: new Date().toISOString()
      };
      testPayment = {
        id: paymentId,
        group_id: groupId,
        friend_name: 'Ananya',
        contact: 'ananya@example.com',
        share_minor: 3000,
        public_token: 'valid-public-token-1234',
        paypal_ref: 'ORD-MOCK-123',
        pay_url: 'https://sandbox.paypal.com/pay',
        capture_id: null,
        refund_ref: null,
        status: 'draft',
        paid_at: null,
        last_nudged_at: null
      };

      await groupsRepo.createGroup(testGroup);
      await groupsRepo.createPayments([testPayment]);
    });

    it('GET /pay/:token sets viewed_at and returns friend & group details', async () => {
      const res = await fetch(`${baseUrl}/pay/valid-public-token-1234`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.data.friendName).toBe('Ananya');
      expect(data.data.shareMinor).toBe(3000);

      const refreshed = await groupsRepo.getPaymentById(testPayment.id);
      expect(refreshed?.viewed_at).toBeTruthy();
    });

    it('rejects capture if payment is still in draft (organizer has not sealed via Guardian)', async () => {
      const res = await fetch(`${baseUrl}/pay/valid-public-token-1234/capture`, {
        method: 'POST'
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error.message).toContain('draft');
    });

    it('rejects capture if group is not in pending status', async () => {
      // Set payment to sent, but group to confirmed
      await groupsRepo.updatePaymentStatus(testPayment.id, 'sent');
      await groupsRepo.updateGroupStatus(testGroup.id, 'confirmed');

      const res = await fetch(`${baseUrl}/pay/valid-public-token-1234/capture`, {
        method: 'POST'
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error.message).toContain('pending');
    });

    it('successfully captures sent payment and confirms group when all shares complete', async () => {
      // Put group in pending and payment in sent
      await groupsRepo.updateGroupStatus(testGroup.id, 'pending');
      await groupsRepo.updatePaymentStatus(testPayment.id, 'sent');

      const res = await fetch(`${baseUrl}/pay/valid-public-token-1234/capture`, {
        method: 'POST'
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.data.payment.status).toBe('paid');

      const updatedPayment = await groupsRepo.getPaymentById(testPayment.id);
      expect(updatedPayment?.status).toBe('paid');
      expect(updatedPayment?.capture_id).toBeTruthy();
      expect(updatedPayment?.paid_at).toBeTruthy();

      const updatedGroup = await groupsRepo.getGroupById(testGroup.id);
      expect(updatedGroup?.status).toBe('confirmed');
    });
  });

  describe('PayPal Webhook Idempotency & Reconciliation (POST /webhooks/paypal)', () => {
    let groupId: string;
    let paymentId: string;

    beforeEach(async () => {
      groupId = '88888888-8888-4000-a000-888888888888';
      paymentId = '99999999-9999-4000-a000-999999999999';

      const group: Group = {
        id: groupId,
        organizer_id: userAaravId,
        suggestion_id: null,
        transaction_id: null,
        total_minor: 5000,
        currency: 'USD',
        deadline: new Date(Date.now() + 86400000).toISOString(),
        status: 'pending',
        created_at: new Date().toISOString()
      };
      const payment: GroupPayment = {
        id: paymentId,
        group_id: groupId,
        friend_name: 'Priya',
        contact: 'priya@example.com',
        share_minor: 2500,
        public_token: 'wh-token-abc',
        paypal_ref: 'ORD-WH-123',
        pay_url: 'https://sandbox.paypal.com/pay',
        capture_id: null,
        refund_ref: null,
        status: 'sent',
        paid_at: null,
        last_nudged_at: null
      };

      await groupsRepo.createGroup(group);
      await groupsRepo.createPayments([payment]);
    });

    it('rejects webhook with malformed or missing custom_id', async () => {
      const event = {
        id: 'WH-EVT-001',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-WH-001',
          custom_id: 'malformed_id_without_colon'
        }
      };

      const res = await fetch(`${baseUrl}/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ignored');
    });

    it('rejects webhook when payment does not belong to specified group', async () => {
      const otherGroupId = '11111111-1111-4000-a000-111111111111';
      const otherGroup: Group = {
        id: otherGroupId,
        organizer_id: userPriyaId,
        suggestion_id: null,
        transaction_id: null,
        total_minor: 4000,
        currency: 'USD',
        deadline: new Date(Date.now() + 86400000).toISOString(),
        status: 'pending',
        created_at: new Date().toISOString()
      };
      await groupsRepo.createGroup(otherGroup);

      const event = {
        id: 'WH-EVT-002',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-WH-002',
          status: 'COMPLETED',
          custom_id: `${otherGroupId}:${paymentId}` // paymentId belongs to groupId, not otherGroupId
        }
      };

      const res = await fetch(`${baseUrl}/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });

      // Permanent failure: 200 so PayPal stops retrying, never credited, recorded as failed.
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({ ok: false, status: 'failed' });
      expect((await groupsRepo.getPaymentById(paymentId))?.status).toBe('sent');
    });

    it('rejects webhook with amount mismatch', async () => {
      const event = {
        id: 'WH-EVT-003',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-WH-003',
          status: 'COMPLETED',
          custom_id: `${groupId}:${paymentId}`,
          amount: {
            value: '99.99', // share_minor is 2500 ($25.00)
            currency_code: 'USD'
          }
        }
      };

      const res = await fetch(`${baseUrl}/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({ ok: false, status: 'failed' });
      expect(JSON.stringify(data)).not.toContain('99.99'); // nothing echoed back to the caller
      expect((await groupsRepo.getPaymentById(paymentId))?.status).toBe('sent');
    });

    it('processes valid capture webhook and ignores duplicates idempotently', async () => {
      const event = {
        id: 'WH-EVT-004-UNIQUE',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-WH-004',
          status: 'COMPLETED',
          custom_id: `${groupId}:${paymentId}`,
          amount: {
            value: '25.00',
            currency_code: 'USD'
          }
        }
      };

      // 1. First delivery -> processed
      const res1 = await fetch(`${baseUrl}/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });

      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.ok).toBe(true);

      const payment = await groupsRepo.getPaymentById(paymentId);
      expect(payment?.status).toBe('paid');
      expect(payment?.capture_id).toBe('CAP-WH-004');

      // 2. Duplicate redelivery -> idempotent duplicate return
      const res2 = await fetch(`${baseUrl}/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });

      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.duplicate).toBe(true);
    });
  });
});