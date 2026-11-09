import { describe, it, expect } from 'vitest';
import { q, asRole, seedProfile, insertApproval } from './helpers.js';

describe('schema invariants', () => {
  it('migrations applied from empty: core tables and functions exist', async () => {
    const t = (await q(`select table_name from information_schema.tables where table_schema='public'`)).rows.map((r) => r.table_name);
    for (const n of ['profiles', 'approvals', 'approval_events', 'audit_log', 'job_runs', 'group_payments', 'erased_users']) expect(t).toContain(n);
    const f = (await q(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).rows.map((r) => r.proname);
    for (const n of ['erase_user', 'weekly_money_out_for']) expect(f).toContain(n);
  });

  it('transition guard blocks illegal transitions and any exit from terminal states', async () => {
    const uid = await seedProfile();
    const a = await insertApproval(uid, { status: 'pending' });
    await expect(q(`update approvals set status='executed' where id=$1`, [a])).rejects.toThrow(/Invalid approval transition/);
    await q(`update approvals set status='denied' where id=$1`, [a]);
    await expect(q(`update approvals set status='approved' where id=$1`, [a])).rejects.toThrow(/terminal/);
    const b = await insertApproval(uid, { status: 'approved' });
    await expect(q(`update approvals set status='pending' where id=$1`, [b])).rejects.toThrow(/Invalid approval transition/);
  });

  it('authenticated cannot raise its own caps; service_role can', async () => {
    const uid = await seedProfile({ weekly: 1000, perAction: 500 });
    await expect(asRole('authenticated', uid, (c) => c.query(`update profiles set weekly_cap_minor=999999 where id=$1`, [uid]))).rejects.toThrow(/cap escalation/);
    await expect(asRole('authenticated', uid, (c) => c.query(`update profiles set per_action_cap_minor=999999 where id=$1`, [uid]))).rejects.toThrow(/cap escalation/);
    await asRole('authenticated', uid, (c) => c.query(`update profiles set name='ok' where id=$1`, [uid]));
    await asRole('service_role', null, (c) => c.query(`update profiles set weekly_cap_minor=2000 where id=$1`, [uid]));
    expect((await q(`select weekly_cap_minor from profiles where id=$1`, [uid])).rows[0].weekly_cap_minor).toBe('2000');
  });

  it('currency allowlist is enforced', async () => {
    await expect(q(`insert into profiles(id,name,currency) values (gen_random_uuid(),'x','XYZ')`)).rejects.toThrow(/chk_profiles_currency/);
  });

  it('vault, pockets and webhook defaults satisfy their own CHECK constraints', async () => {
    // Regression: webhook_events default status 'received' violated the status CHECK from 004.
    await q(`insert into webhook_events(id,event_type,payload) values ('evt_default_status','X','{}')`);
    await expect(q(`insert into pockets(user_id,kind,balance_minor) values ($1,'weekly',-1)`, [await seedProfile()])).rejects.toThrow();
  });
});
