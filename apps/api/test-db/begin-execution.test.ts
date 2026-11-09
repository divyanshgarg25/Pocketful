import { describe, it, expect } from 'vitest';
import { q, asRole, seedProfile, insertApproval } from './helpers.js';

const run = (id: string, uid: string, tz = 'UTC') =>
  asRole('service_role', null, async (c) => {
    const res = await c.query("select begin_execution($1,$2,$3,array['approved','failed']) as r", [id, uid, tz]);
    const r = res.rows[0].r;
    if (!r.ok) {
      const err: any = new Error(r.reason ?? r.code);
      err.code = r.code === 'WEEKLY_CAP' || r.code === 'PER_ACTION_CAP' || r.code === 'CAP_ZERO' ? 'P0005'
        : r.code === 'NOT_FOUND' ? 'P0002'
        : r.code === 'BAD_STATUS' ? 'P0003'
        : r.code === 'EXPIRED' ? 'P0004' : r.code;
      throw err;
    }
    const a = await c.query('select status from approvals where id = $1', [id]);
    return a.rows[0].status as string;
  });

describe('begin_execution (B3) on real Postgres', () => {
  it('parallel executions of staged approvals can never exceed the weekly cap (executing rows count)', async () => {
    const uid = await seedProfile({ weekly: 6000, perAction: 5000 });
    const ids = await Promise.all(Array.from({ length: 6 }, () => insertApproval(uid, { status: 'approved', money: 4000, action: 'vault_move' })));
    const results = await Promise.allSettled(ids.map((id) => run(id, uid)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rej).toHaveLength(5);
    expect(rej.every((r) => (r.reason as any).code === 'P0005')).toBe(true);
    const total = (await q(`select coalesce(sum(money_out_minor),0)::int n from approvals where user_id=$1 and status='executing'`, [uid])).rows[0].n;
    expect(total).toBeLessThanOrEqual(6000);
  });

  it('uses CURRENT caps, zero caps block money-out, zero-money actions still pass', async () => {
    const uid = await seedProfile({ weekly: 0, perAction: 0 });
    const move = await insertApproval(uid, { status: 'approved', money: 100 });
    const cancel = await insertApproval(uid, { status: 'approved', money: 0, action: 'cancel_subscription' });
    await expect(run(move, uid)).rejects.toMatchObject({ code: 'P0005' });
    expect(await run(cancel, uid)).toBe('executing');
  });

  it('rejects wrong status, wrong owner and expired approvals with distinct codes', async () => {
    const uid = await seedProfile();
    const other = await seedProfile();
    const pending = await insertApproval(uid, { status: 'pending' });
    await expect(run(pending, uid)).rejects.toMatchObject({ code: 'P0003' });
    const mine = await insertApproval(uid, { status: 'approved', money: 1 });
    await expect(run(mine, other)).rejects.toMatchObject({ code: 'P0002' });
    const old = await insertApproval(uid, { status: 'approved', money: 1 });
    await q(`update approvals set expires_at = now() - interval '1 minute' where id=$1`, [old]);
    await expect(run(old, uid)).rejects.toMatchObject({ code: 'P0004' });
  });

  it('a failed approval can be re-begun (retry path) and counts only once', async () => {
    const uid = await seedProfile({ weekly: 5000, perAction: 5000 });
    const f = await insertApproval(uid, { status: 'failed', money: 4000 });
    expect(await run(f, uid)).toBe('executing');
  });
});
