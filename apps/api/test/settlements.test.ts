import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { config } from '../src/core/config.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { splitterAgent } from '../src/agents/splitter.js';
import { settlePayment, refundLateCapture } from '../src/services/settlement.js';
import { settlementsRepo } from '../src/repos/settlements.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { paypalService, buildPayee } from '../src/services/paypal.js';
import { moneyService } from '../src/services/money.js';

const userId = '00000000-0000-4000-a000-000000000001';
const friends = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `F${i + 1}`, contact: `f${i + 1}@example.com` }));
const MERCHANT = 'ABCDE12345678';
const OTHER = 'ZZZZZ99999999';

describe('C3: settlements ledger and payee', () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    initLocalSeed();
    await new Promise<void>((r) => {
      server = app.listen(0, () => {
        const a = server.address();
        if (a && typeof a === 'object') baseUrl = `http://localhost:${a.port}`;
        r();
      });
    });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  beforeEach(() => {
    initLocalSeed();
    localDb.approvals.clear();
    localDb.groups.clear();
    localDb.group_payments.clear();
    localDb.settlements.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    config.PAYPAL_PAYEE_MERCHANT_ID = undefined;
    config.PAYPAL_PAYEE_EMAIL = undefined;
  });

  /** A pending outing with every friend's request sent, ready to be paid. */
  const payableGroup = async (n = 2, total = 9001) => {
    const g = await splitterAgent.createGroupSplit(userId, { totalMinor: total, friends: friends(n), splitMode: 'equal' });
    localDb.groups.get(g.group.id)!.status = 'pending';
    const payments = [...localDb.group_payments.values()].filter((p) => p.group_id === g.group.id);
    payments.forEach((p) => { p.status = 'sent'; });
    return { group: localDb.groups.get(g.group.id)!, payments };
  };
  const settle = (group: { id: string; currency: string }, p: { id: string; share_minor: number }, over: Record<string, unknown> = {}) =>
    settlePayment({ groupId: group.id, paymentId: p.id, captureId: `CAP_${p.id.slice(0, 6)}`, amountValue: moneyService.toPayPalValue(p.share_minor, group.currency), currency: group.currency, source: 'capture_route', ...over });

  describe('recording', () => {
    it('a settled capture writes exactly one ledger row with the right amount, currency, organizer and actor', async () => {
      const { group, payments } = await payableGroup();
      const r = await settle(group, payments[0]!);
      expect(r.outcome).toBe('settled');
      const rows = await settlementsRepo.listForGroup(group.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'capture', payment_id: payments[0]!.id, amount_minor: payments[0]!.share_minor, currency: group.currency, organizer_id: userId, actor: 'friend_capture', paypal_refund_id: null });
      expect(rows[0]!.paypal_capture_id).toBe(`CAP_${payments[0]!.id.slice(0, 6)}`);
    });

    it('a webhook-settled capture is attributed to the webhook', async () => {
      const { group, payments } = await payableGroup();
      await settle(group, payments[0]!, { source: 'webhook' });
      expect((await settlementsRepo.listForGroup(group.id))[0]!.actor).toBe('webhook');
    });

    it('settling the same capture again (webhook retry or double click) never writes a second row', async () => {
      const { group, payments } = await payableGroup();
      await settle(group, payments[0]!);
      expect((await settle(group, payments[0]!, { source: 'webhook' })).outcome).toBe('already_paid');
      expect(await settlementsRepo.listForGroup(group.id)).toHaveLength(1);
    });

    it('a retry HEALS a missing ledger row (payment marked paid, then the ledger write failed)', async () => {
      const { group, payments } = await payableGroup();
      await settle(group, payments[0]!);
      localDb.settlements.clear(); // simulate the lost write
      expect((await settle(group, payments[0]!, { source: 'webhook' })).outcome).toBe('already_paid');
      expect(await settlementsRepo.listForGroup(group.id)).toHaveLength(1);
    });

    it('does not record anything for a rejected capture (amount mismatch)', async () => {
      const { group, payments } = await payableGroup();
      const r = await settle(group, payments[0]!, { amountValue: '0.01' });
      expect(r).toEqual({ outcome: 'rejected', code: 'AMOUNT_MISMATCH' });
      expect(await settlementsRepo.listForGroup(group.id)).toEqual([]);
    });

    it('record() is idempotent per (payment, kind) and rejects non-positive amounts', async () => {
      const base = { group_id: crypto.randomUUID(), payment_id: crypto.randomUUID(), organizer_id: null, kind: 'capture' as const, amount_minor: 500, currency: 'USD', paypal_capture_id: 'C1', paypal_refund_id: null, actor: 'system' as const };
      expect(await settlementsRepo.record(base)).toBe(true);
      expect(await settlementsRepo.record(base)).toBe(false);
      await expect(settlementsRepo.record({ ...base, payment_id: crypto.randomUUID(), amount_minor: 0 })).rejects.toThrow(/positive integer/);
      await expect(settlementsRepo.record({ ...base, payment_id: crypto.randomUUID(), amount_minor: 1.5 })).rejects.toThrow(/positive integer/);
    });
  });

  describe('refunds', () => {
    it('refundAllPaid records a refund per payment and the group ends holding nothing', async () => {
      const { group, payments } = await payableGroup(3);
      for (const p of payments) await settle(group, p);
      const before = await settlementsRepo.summarize(group.id);
      expect(before).toMatchObject({ captures: 3, refunds: 0, refundedMinor: 0 });
      expect(before.heldMinor).toBe(before.collectedMinor);
      await splitterAgent.refundAllPaid(group.id, { finalStatus: 'refunded', actor: userId });
      const after = await settlementsRepo.summarize(group.id);
      expect(after).toMatchObject({ captures: 3, refunds: 3, heldMinor: 0 });
      expect(after.collectedMinor).toBe(before.collectedMinor);
      expect((await settlementsRepo.listForGroup(group.id)).filter((r) => r.kind === 'refund').every((r) => r.actor === 'organizer' && r.paypal_refund_id)).toBe(true);
    });

    it('a refund of a payment that pre-dates the ledger first back-fills its capture (never a refund without a capture)', async () => {
      const { group, payments } = await payableGroup(1);
      const p = payments[0]!;
      Object.assign(localDb.group_payments.get(p.id)!, { status: 'paid', capture_id: 'LEGACY_CAP' });
      await splitterAgent.refundAllPaid(group.id, { finalStatus: 'refunded', actor: 'system' });
      const rows = await settlementsRepo.listForGroup(group.id);
      expect(rows.map((r) => r.kind).sort()).toEqual(['capture', 'refund']);
      expect(rows.find((r) => r.kind === 'refund')!.actor).toBe('system');
    });

    it('a late capture is recorded as captured AND refunded (net zero held)', async () => {
      const { group, payments } = await payableGroup(1);
      localDb.groups.get(group.id)!.status = 'cancelled';
      const r = await settle(group, payments[0]!);
      expect(r.outcome).toBe('late_capture_refunded');
      expect(await settlementsRepo.summarize(group.id)).toMatchObject({ captures: 1, refunds: 1, heldMinor: 0 });
    });

    it('if the automatic refund FAILS the ledger still shows the money as held (so it is not forgotten)', async () => {
      const { group, payments } = await payableGroup(1);
      vi.spyOn(paypalService, 'refundCapture').mockRejectedValue(new Error('PayPal down'));
      const r = await refundLateCapture(payments[0]!.id, 'CAP_STUCK', 'webhook');
      expect(r.outcome).toBe('late_capture_refund_failed');
      const s = await settlementsRepo.summarize(group.id);
      expect(s).toMatchObject({ captures: 1, refunds: 0 });
      expect(s.heldMinor).toBe(payments[0]!.share_minor);
    });
  });

  describe('payee', () => {
    it('buildPayee prefers the merchant id, falls back to the email, and is undefined when unset', () => {
      expect(buildPayee()).toBeUndefined();
      config.PAYPAL_PAYEE_EMAIL = 'pay@pocketful.example';
      expect(buildPayee()).toEqual({ email_address: 'pay@pocketful.example' });
      config.PAYPAL_PAYEE_MERCHANT_ID = MERCHANT;
      expect(buildPayee()).toEqual({ merchant_id: MERCHANT });
    });

    it('a capture received by a DIFFERENT merchant is rejected, not settled, and not recorded', async () => {
      config.PAYPAL_PAYEE_MERCHANT_ID = MERCHANT;
      const { group, payments } = await payableGroup();
      const r = await settle(group, payments[0]!, { payeeMerchantId: OTHER });
      expect(r).toEqual({ outcome: 'rejected', code: 'PAYEE_MISMATCH' });
      expect(localDb.group_payments.get(payments[0]!.id)!.status).toBe('sent');
      expect(await settlementsRepo.listForGroup(group.id)).toEqual([]);
    });

    it('settles when the reported merchant matches, or when PayPal did not report one', async () => {
      config.PAYPAL_PAYEE_MERCHANT_ID = MERCHANT;
      const { group, payments } = await payableGroup();
      expect((await settle(group, payments[0]!, { payeeMerchantId: MERCHANT })).outcome).toBe('settled');
      expect((await settle(group, payments[1]!)).outcome).toBe('settled');
    });

    it('does not check the payee when none is configured (development)', async () => {
      const { group, payments } = await payableGroup();
      expect((await settle(group, payments[0]!, { payeeMerchantId: OTHER })).outcome).toBe('settled');
    });

    it('the order sent to PayPal NAMES the payee (merchant id), and omits it only when unconfigured', async () => {
      const bodies: Array<{ purchase_units: Array<Record<string, unknown>> }> = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
        bodies.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ id: 'ORDER1', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal.example/approve' }] }), { status: 201 });
      }));
      const sim = config.PAYPAL_SIMULATE;
      config.PAYPAL_SIMULATE = false;
      (paypalService as unknown as { tokenCache: unknown }).tokenCache = null;
      try {
        config.PAYPAL_PAYEE_MERCHANT_ID = MERCHANT;
        await paypalService.createFriendSplitOrder('Sam', 3334, 'USD', 'g1:p1');
        expect(bodies[0]!.purchase_units[0]!['payee']).toEqual({ merchant_id: MERCHANT });
        expect(bodies[0]!.purchase_units[0]!['custom_id']).toBe('g1:p1');

        config.PAYPAL_PAYEE_MERCHANT_ID = undefined;
        await paypalService.createFriendSplitOrder('Sam', 3334, 'USD', 'g1:p2');
        expect('payee' in bodies[1]!.purchase_units[0]!).toBe(false);
      } finally {
        config.PAYPAL_SIMULATE = sim;
        (paypalService as unknown as { tokenCache: unknown }).tokenCache = null;
      }
    });
  });

  describe('GET /api/groups/:id/settlement', () => {
    const get = async (token: string, id: string) => {
      const res = await fetch(`${baseUrl}/api/groups/${id}/settlement`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status, json: (await res.json()) as { data: Record<string, unknown> } };
    };

    it("shows the organizer the entries and what the platform holds, and says funds are held by the platform", async () => {
      const token = await createDevToken(userId, 'aarav@pocketful.demo', 'Aarav Sharma');
      const { group, payments } = await payableGroup(2);
      await settle(group, payments[0]!);
      await settle(group, payments[1]!);
      const r = await get(token, group.id);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ groupId: group.id, captures: 2, refunds: 0, heldBy: 'platform', currency: group.currency });
      expect(r.json.data['heldMinor']).toBe(payments[0]!.share_minor + payments[1]!.share_minor);
      const entries = r.json.data['entries'] as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(2);
      expect(JSON.stringify(entries)).not.toContain('paypal_capture_id'); // internal PayPal ids are not exposed
    });

    it("is invisible to anyone else (404, not 403) and for unknown groups", async () => {
      const { group } = await payableGroup();
      const intruder = await createDevToken(crypto.randomUUID(), 'x@example.com', 'X');
      expect((await get(intruder, group.id)).status).toBe(404);
      const token = await createDevToken(userId, 'aarav@pocketful.demo', 'Aarav Sharma');
      expect((await get(token, crypto.randomUUID())).status).toBe(404);
    });
  });

  it('erasing the organizer keeps the ledger rows (amounts) but removes the link to them', async () => {
    const { group, payments } = await payableGroup(1);
    await settle(group, payments[0]!);
    await profilesRepo.eraseUser(userId);
    const rows = await settlementsRepo.listForGroup(group.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizer_id: null, amount_minor: payments[0]!.share_minor });
  });
});
