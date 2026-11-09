import './env.js';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { q, asRole, seedProfile } from './helpers.js';

const { settlementsRepo } = await import('../src/repos/settlements.js');
const { isRemoteSupabaseEnabled } = await import('../src/core/database.js');

const entry = (organizer: string | null, over: Record<string, unknown> = {}) => ({
  group_id: randomUUID(),
  payment_id: randomUUID(),
  organizer_id: organizer,
  kind: 'capture' as const,
  amount_minor: 3334,
  currency: 'USD',
  paypal_capture_id: `CAP_${randomUUID().slice(0, 8)}`,
  paypal_refund_id: null,
  actor: 'friend_capture' as const,
  ...over
});
const insertSql = (e: ReturnType<typeof entry>) =>
  q(
    `insert into settlements(group_id,payment_id,organizer_id,kind,amount_minor,currency,paypal_capture_id,paypal_refund_id,actor)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.group_id, e.payment_id, e.organizer_id, e.kind, e.amount_minor, e.currency, e.paypal_capture_id, e.paypal_refund_id, e.actor]
  );

describe('settlements ledger on real Postgres + PostgREST (C3)', () => {
  it('uses the real driver', () => expect(isRemoteSupabaseEnabled).toBe(true));

  describe('append-only', () => {
    it('UPDATE and DELETE are refused, even for a superuser', async () => {
      const e = entry(null);
      await insertSql(e);
      await expect(q(`update settlements set amount_minor = 1 where payment_id=$1`, [e.payment_id])).rejects.toThrow(/append-only/);
      await expect(q(`update settlements set kind='refund', paypal_refund_id='R' where payment_id=$1`, [e.payment_id])).rejects.toThrow(/append-only/);
      await expect(q(`delete from settlements where payment_id=$1`, [e.payment_id])).rejects.toThrow(/append-only/);
      expect((await q(`select amount_minor from settlements where payment_id=$1`, [e.payment_id])).rows[0].amount_minor).toBe('3334');
    });

    it('TRUNCATE is refused', async () => {
      await expect(q(`truncate settlements`)).rejects.toThrow(/append-only/);
    });

    it('the ONLY allowed change is nulling organizer_id (what erasure does), and not as a disguise for another edit', async () => {
      const u = await seedProfile();
      const e = entry(u);
      await insertSql(e);
      await expect(q(`update settlements set organizer_id = null, amount_minor = 9 where payment_id=$1`, [e.payment_id])).rejects.toThrow(/append-only/);
      await expect(q(`update settlements set organizer_id = $2 where payment_id=$1`, [e.payment_id, await seedProfile()])).rejects.toThrow(/append-only/);
      await q(`update settlements set organizer_id = null where payment_id=$1`, [e.payment_id]);
      expect((await q(`select organizer_id from settlements where payment_id=$1`, [e.payment_id])).rows[0].organizer_id).toBeNull();
    });
  });

  describe('constraints', () => {
    it.each([
      ['a zero amount', { amount_minor: 0 }, /settlements_amount_minor_check/],
      ['a negative amount', { amount_minor: -5 }, /settlements_amount_minor_check/],
      ['an unsupported currency', { currency: 'XYZ' }, /settlements_currency_check/],
      ['an unknown kind', { kind: 'payout' as never }, /settlements_kind_check/],
      ['an unknown actor', { actor: 'organizer_payout' as never }, /settlements_actor_check/],
      ['a refund without a refund id', { kind: 'refund' as never }, /chk_settlements_refund_id/],
      ['a capture carrying a refund id', { paypal_refund_id: 'R1' }, /chk_settlements_refund_id/]
    ])('rejects %s', async (_n, over, re) => {
      await expect(insertSql(entry(null, over))).rejects.toThrow(re);
    });

    it('allows one capture and one refund per payment, but not two of the same kind', async () => {
      const cap = entry(null);
      await insertSql(cap);
      await insertSql({ ...cap, kind: 'refund', paypal_refund_id: 'R1' });
      await expect(insertSql({ ...cap, paypal_capture_id: 'OTHER' })).rejects.toThrow(/uq_settlements_payment_kind/);
      await expect(insertSql({ ...cap, kind: 'refund', paypal_refund_id: 'R2' })).rejects.toThrow(/uq_settlements_payment_kind/);
    });
  });

  describe('repo through PostgREST', () => {
    it('record() writes once; 8 concurrent writers of the same (payment, kind) produce exactly one row', async () => {
      const u = await seedProfile();
      const e = entry(u);
      const results = await Promise.all(Array.from({ length: 8 }, () => settlementsRepo.record(e)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(Number((await q(`select count(*)::int n from settlements where payment_id=$1`, [e.payment_id])).rows[0].n)).toBe(1);
      expect(await settlementsRepo.record(e)).toBe(false);
    });

    it('summarize() = collected - refunded, from rows read back through PostgREST', async () => {
      const u = await seedProfile();
      const groupId = randomUUID();
      const payments = [randomUUID(), randomUUID(), randomUUID()];
      for (const [i, p] of payments.entries()) await settlementsRepo.record(entry(u, { group_id: groupId, payment_id: p, amount_minor: 1000 + i }));
      await settlementsRepo.record(entry(u, { group_id: groupId, payment_id: payments[0]!, kind: 'refund', paypal_refund_id: 'RF1', amount_minor: 1000 }));
      const s = await settlementsRepo.summarize(groupId);
      expect(s).toMatchObject({ collectedMinor: 3003, refundedMinor: 1000, heldMinor: 2003, captures: 3, refunds: 1, currency: 'USD' });
      expect(Number.isInteger(s.heldMinor)).toBe(true); // bigint columns come back as numbers/strings: totals must still be numeric
    });

    it('an empty group summarizes to zero', async () => {
      expect(await settlementsRepo.summarize(randomUUID())).toMatchObject({ collectedMinor: 0, refundedMinor: 0, heldMinor: 0, captures: 0, refunds: 0, currency: null });
    });
  });

  describe('privileges and erasure', () => {
    it('client roles cannot read or write the ledger', async () => {
      const u = await seedProfile();
      for (const role of ['anon', 'authenticated'] as const) {
        await expect(asRole(role, u, (c) => c.query(`select * from settlements`))).rejects.toThrow(/permission denied/);
        await expect(asRole(role, u, (c) => c.query(`delete from settlements`))).rejects.toThrow(/permission denied/);
      }
    });

    it('even service_role can only SELECT and INSERT: it has no UPDATE or DELETE privilege', async () => {
      const e = entry(null);
      await insertSql(e);
      await expect(asRole('service_role', null, (c) => c.query(`update settlements set amount_minor=1 where payment_id=$1`, [e.payment_id]))).rejects.toThrow(/permission denied/);
      await expect(asRole('service_role', null, (c) => c.query(`delete from settlements where payment_id=$1`, [e.payment_id]))).rejects.toThrow(/permission denied/);
    });

    it('erase_user keeps the ledger rows (amounts) and nulls only the organizer link; other organizers are untouched', async () => {
      const victim = await seedProfile();
      const bystander = await seedProfile();
      const v = entry(victim);
      const b = entry(bystander);
      await insertSql(v);
      await insertSql(b);
      expect((await asRole('service_role', null, (c) => c.query('select erase_user($1) as ok', [victim]))).rows[0].ok).toBe(true);
      const rv = (await q(`select organizer_id, amount_minor from settlements where payment_id=$1`, [v.payment_id])).rows[0];
      expect(rv.organizer_id).toBeNull();
      expect(rv.amount_minor).toBe('3334');
      expect((await q(`select organizer_id from settlements where payment_id=$1`, [b.payment_id])).rows[0].organizer_id).toBe(bystander);
    });
  });
});
