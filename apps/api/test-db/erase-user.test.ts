import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { q, asRole, seedProfile, insertApproval, pool } from './helpers.js';

async function seedFullUser() {
  const uid = await seedProfile();
  const other = await seedProfile(); // must be untouched by erasure
  await q(`insert into preferences(user_id) values ($1)`, [uid]);
  await q(`insert into vault(user_id) values ($1)`, [uid]);
  await q(`insert into pockets(user_id,kind,balance_minor) values ($1,'weekly',100),($1,'holiday',5)`, [uid]);
  await q(`insert into subscriptions(user_id,merchant,amount_minor,interval) values ($1,'m',1,'monthly')`, [uid]);
  await q(`insert into chat_messages(user_id,role,content) values ($1,'user','hi')`, [uid]);
  await q(`insert into mood_checkins(user_id,week,level) values ($1,'2026-W44','okay')`, [uid]);
  await q(`insert into nudge_settings(user_id) values ($1)`, [uid]);
  await q(`insert into user_leave_days(user_id,day) values ($1,'2026-11-10')`, [uid]);
  const plan = (await q(`insert into plans(user_id,week,group_size,budget_minor,radius_km) values ($1,'2026-W44',1,100,5) returning id`, [uid])).rows[0].id;
  const venue = (await q(`insert into venues_cache(name,category,lat,lng) values ('v','cafes',1,1) returning id`)).rows[0].id;
  await q(`insert into suggestions(user_id,plan_id,venue_id,slot,features) values ($1,$2,$3,'comfort','{}')`, [uid, plan, venue]);
  await q(`insert into transactions(user_id,source,source_ref,occurred_at,amount_minor,currency,merchant_raw,merchant_norm) values ($1,'manual',$2,now(),1,'USD','m','m')`, [uid, randomUUID()]);
  await q(`insert into learning_events(user_id,event_type,weight,features) values ($1,'e',1,'{}')`, [uid]);
  await q(`insert into bandit_state(user_id,feature,value) values ($1,'category','cafes')`, [uid]);
  await q(`insert into habits(user_id,day_of_week,time_bucket,category,typical_amount_minor,occurrences) values ($1,5,'evening','cafes',1,1)`, [uid]);
  await q(`insert into occasions(user_id,type,title,starts_on,ends_on) values ($1,'weekend','t','2026-11-07','2026-11-08')`, [uid]);
  const g = (await q(`insert into groups(organizer_id,total_minor,currency,deadline,status) values ($1,3000,'USD',now()+interval '1 day','pending') returning id`, [uid])).rows[0].id;
  await q(`insert into group_payments(group_id,friend_name,contact,share_minor,status) values ($1,'f','f@x.test',1000,'paid')`, [g]);
  // Approvals driven through real transitions so approval_events rows exist (trigger-created).
  const a = await insertApproval(uid, { status: 'pending', money: 500 });
  await q(`update approvals set status='approved' where id=$1`, [a]);
  await q(`update approvals set status='executing' where id=$1`, [a]);
  await q(`update approvals set status='executed', executed_at=now() where id=$1`, [a]);
  await insertApproval(uid, { status: 'pending' });
  await q(`insert into audit_log(user_id,agent,action,params,result,approval_id) values ($1,'guardian','x','{"secret":"pii"}','{"secret":"pii"}',$2)`, [uid, a]);
  await q(`insert into audit_log(user_id,agent,action) values ($1,'guardian','y')`, [other]);
  return { uid, other };
}

describe('erase_user (A2)', () => {
  it('succeeds as service_role and leaves zero rows for the user in every table', async () => {
    const { uid, other } = await seedFullUser();
    const evBefore = (await q(`select count(*)::int n from approval_events e join approvals a on a.id=e.approval_id where a.user_id=$1`, [uid])).rows[0].n;
    expect(evBefore).toBeGreaterThan(0);

    const r = await asRole('service_role', null, (c) => c.query('select erase_user($1) as ok', [uid]));
    expect(r.rows[0].ok).toBe(true);

    // Generic sweep: every public table with a user-ish column must have zero rows for uid.
    const cols = (await q(`select table_name, column_name from information_schema.columns
      where table_schema='public' and column_name in ('user_id','organizer_id') order by 1`)).rows;
    for (const { table_name, column_name } of cols) {
      if (table_name === 'audit_log' || table_name === 'erased_users') continue; // audit anonymised (asserted below); tombstone is intentional
      const n = (await q(`select count(*)::int n from "${table_name}" where "${column_name}"=$1`, [uid])).rows[0].n;
      expect(n, `${table_name}.${column_name}`).toBe(0);
    }
    expect((await q(`select count(*)::int n from profiles where id=$1`, [uid])).rows[0].n).toBe(0);
    expect((await q(`select count(*)::int n from group_payments gp left join groups g on g.id=gp.group_id where g.id is null`)).rows[0].n).toBe(0);
    expect((await q(`select count(*)::int n from audit_log where user_id=$1`, [uid])).rows[0].n).toBe(0);
    // Other user untouched.
    expect((await q(`select count(*)::int n from profiles where id=$1`, [other])).rows[0].n).toBe(1);
    expect((await q(`select count(*)::int n from audit_log where user_id=$1`, [other])).rows[0].n).toBe(1);
  });

  it('anonymises audit rows (params/result redacted, user_id null) instead of deleting them', async () => {
    const { uid } = await seedFullUser();
    const before = (await q(`select id from audit_log where user_id=$1`, [uid])).rows.map((r) => r.id);
    await asRole('service_role', null, (c) => c.query('select erase_user($1)', [uid]));
    const rows = (await q(`select * from audit_log where id = any($1)`, [before])).rows;
    expect(rows).toHaveLength(before.length);
    for (const r of rows) {
      expect(r.user_id).toBeNull();
      expect(r.params).toEqual({ redacted: true });
      expect(r.result).toEqual({ redacted: true });
    }
  });

  it('writes an erased_users tombstone', async () => {
    const { uid } = await seedFullUser();
    await asRole('service_role', null, (c) => c.query('select erase_user($1)', [uid]));
    expect((await q(`select count(*)::int n from erased_users where user_id=$1`, [uid])).rows[0].n).toBe(1);
  });

  it('is not callable by authenticated users', async () => {
    const { uid } = await seedFullUser();
    await expect(asRole('authenticated', uid, (c) => c.query('select erase_user($1)', [uid]))).rejects.toThrow();
  });
});

describe('audit_log immutability (A2)', () => {
  it('UPDATE and DELETE always raise without the erasure flag, including the old user_id-null loophole', async () => {
    const uid = await seedProfile();
    const id = (await q(`insert into audit_log(user_id,agent,action,params) values ($1,'t','a','{"k":1}') returning id`, [uid])).rows[0].id;
    await expect(q(`update audit_log set params='{}' where id=$1`, [id])).rejects.toThrow(/append-only/);
    await expect(q(`update audit_log set user_id=null, params='{"forged":true}' where id=$1`, [id])).rejects.toThrow(/append-only/);
    await expect(q(`delete from audit_log where id=$1`, [id])).rejects.toThrow(/append-only/);
    // Flag set in a different, committed context must not leak across transactions.
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('pocketful.erasure','on',true)`);
      await c.query('commit');
      await expect(c.query(`update audit_log set params='{}' where id=$1`, [id])).rejects.toThrow(/append-only/);
    } finally { c.release(); }
  });

  it('TRUNCATE on audit_log, approvals and approval_events stays forbidden, even with the erasure flag', async () => {
    for (const t of ['audit_log', 'approvals', 'approval_events']) {
      await expect(q(`truncate ${t} cascade`)).rejects.toThrow();
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('pocketful.erasure','on',true)`);
        await expect(c.query(`truncate ${t} cascade`)).rejects.toThrow();
      } finally { await c.query('rollback').catch(() => {}); c.release(); }
    }
  });

  it('approval_events are immutable without the flag', async () => {
    const uid = await seedProfile();
    const a = await insertApproval(uid, { status: 'pending' });
    await q(`update approvals set status='approved' where id=$1`, [a]);
    await expect(q(`delete from approval_events where approval_id=$1`, [a])).rejects.toThrow(/immutable/);
    await expect(q(`update approval_events set actor='x' where approval_id=$1`, [a])).rejects.toThrow(/immutable/);
  });
});
