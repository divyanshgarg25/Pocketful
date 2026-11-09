import './env.js';
import { describe, it, expect, vi } from 'vitest';
import { q } from './helpers.js';

const { profilesRepo } = await import('../src/repos/profiles.js');
const { jobRunner } = await import('../src/jobs/runner.js');
const { isRemoteSupabaseEnabled } = await import('../src/core/database.js');

/** C5: paging must work through the real PostgREST layer (keyset on a uuid column), and the sweep must see EVERY user. */
describe('profile paging on real Postgres + PostgREST', () => {
  it('uses the real driver', () => expect(isRemoteSupabaseEnabled).toBe(true));

  it('forEachPage visits every one of 450 new profiles exactly once, in strictly increasing id order, in pages <= 200', async () => {
    const ids = (await q(`select gen_random_uuid() as id from generate_series(1, 450)`)).rows.map((r) => r.id as string);
    await q(`insert into auth.users(id,email) select x, x::text || '@paging.test' from unnest($1::uuid[]) x`, [ids]);
    await q(
      `insert into profiles(id,name,timezone,currency,weekly_cap_minor,per_action_cap_minor,guilt_free_cap_minor)
       select x,'P','UTC','USD',50000,25000,1000 from unnest($1::uuid[]) x`,
      [ids]
    );

    const sizes: number[] = [];
    const seen: string[] = [];
    const total = await profilesRepo.forEachPage(200, async (page) => {
      sizes.push(page.length);
      seen.push(...page.map((p) => p.id));
    });

    const inDb = Number((await q(`select count(*)::int n from profiles`)).rows[0].n);
    expect(total).toBe(inDb);
    expect(total).toBeGreaterThanOrEqual(450);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates across page boundaries
    for (let i = 1; i < seen.length; i++) expect(seen[i]! > seen[i - 1]!, `order at ${i}`).toBe(true);
    const seenSet = new Set(seen);
    expect(ids.filter((id) => !seenSet.has(id))).toEqual([]); // none missed

    expect((await profilesRepo.getAll()).length).toBe(inDb);
  }, 60_000);

  it('the hourly sweep, through the real lease table, processes every profile and records ok', async () => {
    const inDb = Number((await q(`select count(*)::int n from profiles`)).rows[0].n);
    const spy = vi.spyOn(jobRunner, 'processUserSchedule').mockResolvedValue(undefined);
    await q(`delete from job_runs where job = 'hourly_user_sweep'`);
    await jobRunner.runHourlyUserSweep();
    expect(spy).toHaveBeenCalledTimes(inDb);
    const run = (await q(`select status, detail from job_runs where job = 'hourly_user_sweep' order by started_at desc limit 1`)).rows[0];
    expect(run.status).toBe('ok');
    expect(run.detail).toMatchObject({ processedUsers: inDb });
    spy.mockRestore();
  }, 60_000);

  it('a job that throws leaves a FAILED lease row in Postgres, not a running one, and can be retried in the same period', async () => {
    const key = `test_job_${Date.now()}`;
    await expect(jobRunner.runLeased(key, 10, '2026-W46', async () => { throw new Error('kaboom'); })).rejects.toThrow('kaboom');
    let row = (await q(`select status, detail, finished_at from job_runs where job = $1`, [key])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.detail).toMatchObject({ error: 'kaboom' });
    expect(row.finished_at).not.toBeNull();

    let ran = 0;
    expect(await jobRunner.runLeased(key, 10, '2026-W46', async () => { ran++; })).toBe(true); // retry allowed
    expect(await jobRunner.runLeased(key, 10, '2026-W46', async () => { ran++; })).toBe(false); // now deduplicated (ok)
    expect(ran).toBe(1);
    row = (await q(`select count(*) filter (where status='ok')::int ok, count(*) filter (where status='failed')::int failed, count(*) filter (where status='running')::int running from job_runs where job = $1`, [key])).rows[0];
    expect(row).toEqual({ ok: 1, failed: 1, running: 0 });
  }, 60_000);
});
