import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { groupsRepo } from '../src/repos/groups.js';
import { settlePayment } from '../src/services/settlement.js';
import { splitterAgent } from '../src/agents/splitter.js';
import { config } from '../src/core/config.js';
import { extractCapture } from '../src/routes/webhooks.js';
import type { Group, GroupPayment } from '../src/schemas/domain.js';

const userId = '00000000-0000-4000-a000-000000000001';

describe('Settlement, webhooks and group cancel/refund (C1, C2, C4)', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  const post = async (path: string, body?: unknown, auth = false) => {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const mk = async (statuses: GroupPayment['status'][], groupStatus: Group['status'] = 'pending') => {
    const gid = crypto.randomUUID();
    await groupsRepo.createGroup({
      id: gid, organizer_id: userId, suggestion_id: null, transaction_id: null, total_minor: 9000,
      currency: 'USD', deadline: new Date(Date.now() + 86400000).toISOString(), status: groupStatus,
      created_at: new Date().toISOString()
    } as Group);
    const payments: GroupPayment[] = statuses.map((st, i) => ({
      id: crypto.randomUUID(), group_id: gid, friend_name: `F${i}`, contact: `f${i}@x.com`, share_minor: 3000,
      public_token: crypto.randomBytes(16).toString('hex'), paypal_ref: `ORD-${i}-${gid.slice(0, 6)}`,
      pay_url: 'https://x', capture_id: st === 'paid' ? `CAP-${i}-${gid.slice(0, 6)}` : null, refund_ref: null,
      status: st, paid_at: st === 'paid' ? new Date().toISOString() : null, last_nudged_at: null
    }));
    await groupsRepo.createPayments(payments);
    return { gid, payments };
  };

  beforeAll(async () => {
    initLocalSeed();
    token = await createDevToken(userId, 'aarav@pocketful.demo', 'Aarav Sharma');
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const a = server.address();
        if (a && typeof a === 'object') baseUrl = `http://localhost:${a.port}`;
        resolve();
      });
    });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(() => { initLocalSeed(); });

  describe('webhook payload shapes (C2)', () => {
    it('extracts CHECKOUT.ORDER.COMPLETED from purchase_units[0] (previously always ignored)', () => {
      const got = extractCapture('CHECKOUT.ORDER.COMPLETED', {
        id: 'ORDER1', status: 'COMPLETED',
        purchase_units: [{ custom_id: 'g:p', amount: { value: '30.00', currency_code: 'USD' },
          payments: { captures: [{ id: 'CAP9', status: 'COMPLETED', custom_id: 'g:p', amount: { value: '30.00', currency_code: 'USD' } }] } }]
      });
      expect(got).toEqual({ customId: 'g:p', captureId: 'CAP9', amountValue: '30.00', currency: 'USD' });
    });
    it('ignores non-COMPLETED captures and events without a capture id', () => {
      expect(extractCapture('PAYMENT.CAPTURE.COMPLETED', { id: 'C', status: 'PENDING', custom_id: 'g:p' })).toBeNull();
      expect(extractCapture('CHECKOUT.ORDER.COMPLETED', { id: 'O', status: 'COMPLETED', purchase_units: [{ custom_id: 'g:p' }] })).toBeNull();
    });
    it('credits a payment through a real-shaped CHECKOUT.ORDER.COMPLETED webhook', async () => {
      const { gid, payments } = await mk(['sent']);
      const r = await post('/webhooks/paypal', {
        id: `WH-${crypto.randomUUID()}`, event_type: 'CHECKOUT.ORDER.COMPLETED',
        resource: { id: 'O1', status: 'COMPLETED', purchase_units: [{ custom_id: `${gid}:${payments[0]!.id}`,
          payments: { captures: [{ id: 'CAPX', status: 'COMPLETED', amount: { value: '30.00', currency_code: 'USD' } }] } }] }
      });
      expect(r.status).toBe(200);
      const p = await groupsRepo.getPaymentById(payments[0]!.id);
      expect(p?.status).toBe('paid');
      expect(p?.capture_id).toBe('CAPX');
      expect((await groupsRepo.getGroupById(gid))?.status).toBe('confirmed');
    });
    it('webhook errors never echo internals', async () => {
      const r = await post('/webhooks/paypal', { id: `WH-${crypto.randomUUID()}`, event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'C', status: 'COMPLETED', custom_id: `${crypto.randomUUID()}:${crypto.randomUUID()}`, amount: { value: '1.00', currency_code: 'USD' } } });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, status: 'failed' });
    });
  });

  describe('fail-closed amount/currency (C2)', () => {
    it('rejects a capture with no amount/currency when not simulating', async () => {
      const { gid, payments } = await mk(['sent']);
      const prev = config.PAYPAL_SIMULATE;
      (config as { PAYPAL_SIMULATE: boolean }).PAYPAL_SIMULATE = false;
      try {
        const r = await settlePayment({ groupId: gid, paymentId: payments[0]!.id, captureId: 'C1', source: 'webhook' });
        expect(r).toEqual({ outcome: 'rejected', code: 'MISSING_AMOUNT' });
        expect((await groupsRepo.getPaymentById(payments[0]!.id))?.status).toBe('sent');
        const ok = await settlePayment({ groupId: gid, paymentId: payments[0]!.id, captureId: 'C1', amountValue: '30.00', currency: 'USD', source: 'webhook' });
        expect(ok.outcome).toBe('settled');
      } finally {
        (config as { PAYPAL_SIMULATE: boolean }).PAYPAL_SIMULATE = prev;
      }
    });
    it('rejects wrong currency and wrong amount', async () => {
      const { gid, payments } = await mk(['sent']);
      expect(await settlePayment({ groupId: gid, paymentId: payments[0]!.id, captureId: 'C', amountValue: '30.00', currency: 'EUR', source: 'webhook' }))
        .toEqual({ outcome: 'rejected', code: 'CURRENCY_MISMATCH' });
      expect(await settlePayment({ groupId: gid, paymentId: payments[0]!.id, captureId: 'C', amountValue: '29.99', currency: 'USD', source: 'webhook' }))
        .toEqual({ outcome: 'rejected', code: 'AMOUNT_MISMATCH' });
    });
  });

  describe('late captures are refunded, never stranded (C1)', () => {
    it('a capture landing on a cancelled payment is auto-refunded', async () => {
      const { gid, payments } = await mk(['cancelled']);
      const r = await settlePayment({ groupId: gid, paymentId: payments[0]!.id, captureId: 'CAP-LATE', amountValue: '30.00', currency: 'USD', source: 'webhook' });
      expect(r.outcome).toBe('late_capture_refunded');
      const p = await groupsRepo.getPaymentById(payments[0]!.id);
      expect(p?.status).toBe('refunded');
      expect(p?.refund_ref).toBeTruthy();
      expect(localDb.audit_log.some((a) => a.action === 'late_capture_auto_refund' && a.agent === 'system')).toBe(true);
    });
    it('a capture landing on a cancelled GROUP is auto-refunded', async () => {
      const { gid, payments } = await mk(['sent'], 'cancelled');
      const r = await settlePayment({ groupId: gid, paymentId: payments[0]!.id, captureId: 'CAP-LATE2', amountValue: '30.00', currency: 'USD', source: 'capture_route' });
      expect(r.outcome).toBe('late_capture_refunded');
    });
  });

  describe('cancel with paid friends (C1 / D6)', () => {
    const authedCancel = (gid: string) => post(`/api/groups/${gid}/cancel`, undefined, true);

    it('cancel closes unpaid payments immediately so nobody else can pay', async () => {
      const { gid, payments } = await mk(['paid', 'sent', 'viewed', 'draft']);
      const r = await authedCancel(gid);
      expect(r.status).toBe(200);
      expect(r.json.data.status).toBe('refunding_staged');
      const after = await groupsRepo.getPaymentsByGroupId(gid);
      expect(after.map((p) => p.status)).toEqual(['paid', 'cancelled', 'cancelled', 'cancelled']);
      const late = await post(`/pay/${payments[1]!.public_token}/capture`);
      expect(late.status).toBe(410);
    });

    it('refund execution refunds everyone paid AT EXECUTION, including friends who paid after staging', async () => {
      const { gid, payments } = await mk(['paid', 'paid']);
      // simulate: staged list only knew about payment[0]; payment[1] paid afterwards
      const stagedIds = [payments[0]!.id];
      expect(stagedIds.length).toBe(1);
      const r = await splitterAgent.refundAllPaid(gid, { finalStatus: 'refunded', actor: 'system' });
      expect(r.refundedCount).toBe(2);
      const after = await groupsRepo.getPaymentsByGroupId(gid);
      expect(after.every((p) => p.status === 'refunded')).toBe(true);
      expect((await groupsRepo.getGroupById(gid))?.status).toBe('refunded');
    });

    it('does not mark the group refunded while a capture is in flight', async () => {
      const { gid } = await mk(['paid', 'capturing']);
      await expect(splitterAgent.refundAllPaid(gid, { finalStatus: 'refunded', actor: 'system' })).rejects.toThrow();
      expect((await groupsRepo.getGroupById(gid))?.status).toBe('pending');
    });

    it('the CAS cancel never overwrites a payment that just became paid', async () => {
      const { gid, payments } = await mk(['sent', 'sent']);
      await groupsRepo.transitionPaymentToPaid(payments[0]!.id, 'CAP-RACE', new Date().toISOString());
      const n = await groupsRepo.cancelUnpaidPayments(gid);
      expect(n).toBe(1);
      expect((await groupsRepo.getPaymentById(payments[0]!.id))?.status).toBe('paid');
    });
  });

  describe('capture claim (C4)', () => {
    it('concurrent captures: exactly one reaches settlement, nobody is double-charged', async () => {
      const { payments } = await mk(['sent']);
      const t = payments[0]!.public_token;
      const rs = await Promise.all(Array.from({ length: 6 }, () => post(`/pay/${t}/capture`)));
      const ok = rs.filter((r) => r.status === 200);
      expect(ok.filter((r) => !r.json.data.replayed).length).toBe(1);
      expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      expect((await groupsRepo.getPaymentById(payments[0]!.id))?.status).toBe('paid');
    });
    it('transitionPaymentToPaid is a real CAS: it cannot revive cancelled/refunded/draft payments', async () => {
      const { payments } = await mk(['cancelled', 'refunded', 'draft']);
      for (const p of payments) {
        expect(await groupsRepo.transitionPaymentToPaid(p.id, 'CAP-X', new Date().toISOString())).toBeNull();
        expect((await groupsRepo.getPaymentById(p.id))?.status).toBe(p.status);
      }
    });
    it('stale capturing claims are released', async () => {
      const { payments } = await mk(['sent']);
      await groupsRepo.beginCapture(payments[0]!.id);
      expect(await groupsRepo.beginCapture(payments[0]!.id)).toBeNull();
      const p = localDb.group_payments.get(payments[0]!.id)!;
      localDb.group_payments.set(p.id, { ...p, capture_started_at: new Date(Date.now() - 20 * 60_000).toISOString() });
      expect(await groupsRepo.releaseStaleCaptures(10 * 60_000)).toEqual([p.id]);
      expect((await groupsRepo.getPaymentById(p.id))?.status).toBe('sent');
    });
  });
});
