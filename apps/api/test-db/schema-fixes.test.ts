import './env.js';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { q, seedProfile, insertApproval, serviceClient } from './helpers.js';

describe('schema drift fixes (A4)', () => {
  it('group_payments.viewed_at exists and markPaymentViewed sets status viewed only from sent', async () => {
    const { groupsRepo } = await import('../src/repos/groups.js');
    const uid = await seedProfile();
    const g = (await q(`insert into groups(organizer_id,total_minor,currency,deadline,status) values ($1,3000,'USD',now()+interval '1 day','pending') returning id`, [uid])).rows[0].id;
    const sent = (await q(`insert into group_payments(group_id,friend_name,contact,share_minor,status) values ($1,'a','a@x.t',1000,'sent') returning id`, [g])).rows[0].id;
    const paid = (await q(`insert into group_payments(group_id,friend_name,contact,share_minor,status) values ($1,'b','b@x.t',1000,'paid') returning id`, [g])).rows[0].id;
    await groupsRepo.markPaymentViewed(sent);
    await groupsRepo.markPaymentViewed(paid);
    const s = (await q(`select status, viewed_at from group_payments where id=$1`, [sent])).rows[0];
    expect(s.status).toBe('viewed');
    expect(s.viewed_at).not.toBeNull();
    const p = (await q(`select status from group_payments where id=$1`, [paid])).rows[0];
    expect(p.status).toBe('paid');
  });

  it('second mood check-in in the same ISO week updates instead of erroring and keeps the original id', async () => {
    const { vaultRepo } = await import('../src/repos/vault.js');
    const uid = await seedProfile();
    const first = await vaultRepo.saveMoodCheckin(uid, 'okay');
    const second = await vaultRepo.saveMoodCheckin(uid, 'great');
    expect(second.id).toBe(first.id);
    expect(second.level).toBe('great');
    expect((await q(`select count(*)::int n from mood_checkins where user_id=$1`, [uid])).rows[0].n).toBe(1);
  });

  it('weekly money-out via the repo uses the user timezone and fails closed on error', async () => {
    const { approvalsRepo } = await import('../src/repos/approvals.js');
    const uid = await seedProfile({ tz: 'Asia/Kolkata' });
    await insertApproval(uid, { status: 'executed', money: 321, executedAt: new Date().toISOString() });
    expect(await approvalsRepo.getExecutedThisWeekTotal(uid, 'Asia/Kolkata')).toBe(321);
    await expect(approvalsRepo.getExecutedThisWeekTotal(uid, 'Not/AZone')).rejects.toThrow();
  });

  it('backfill: executed vault/pocket moves with money_out_minor=0 get amount_minor (005 is idempotent)', async () => {
    const uid = await seedProfile();
    const id = randomUUID();
    await q(`insert into approvals(id,user_id,action_type,payload,preview,amount_minor,money_out_minor,status,idempotency_key,expires_at)
             values ($1,$2,'vault_move','{}','p',777,0,'pending','k_backfill_'||$3::text, now()+interval '1h')`, [id, uid, randomUUID()]);
    await q(`update approvals set status='approved' where id=$1`, [id]);
    await q(`update approvals set status='executing' where id=$1`, [id]);
    await q(`update approvals set status='executed', executed_at=now() where id=$1`, [id]);
    expect((await q(`select money_out_minor from approvals where id=$1`, [id])).rows[0].money_out_minor).toBe(0);
    // Re-run the backfill statement from 005 (it is part of the file; extract and execute it).
    const fs = await import('node:fs');
    const sql = fs.readFileSync(new URL('../../../supabase/migrations/005_audit_fixes.sql', import.meta.url), 'utf8');
    const m = sql.match(/-- BACKFILL-BEGIN([\s\S]*?)-- BACKFILL-END/);
    expect(m, 'backfill block present in 005').toBeTruthy();
    await q(m![1]);
    await q(m![1]); // idempotent
    expect((await q(`select money_out_minor from approvals where id=$1`, [id])).rows[0].money_out_minor).toBe(777);
  });

  it('service client can reach PostgREST (harness sanity)', async () => {
    const sb = await serviceClient();
    const { error } = await sb.from('profiles').select('id').limit(1);
    expect(error).toBeNull();
  });
});
