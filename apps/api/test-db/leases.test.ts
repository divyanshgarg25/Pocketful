import './env.js';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { q } from './helpers.js';

const { jobRunner } = await import('../src/jobs/runner.js');
const { isRemoteSupabaseEnabled } = await import('../src/core/database.js');

describe('job leases on real Postgres (A3)', () => {
  it('app is wired to the real DB driver', () => expect(isRemoteSupabaseEnabled).toBe(true));

  it('concurrent acquireLease for one key: exactly one winner', async () => {
    const key = `lock_${randomUUID()}`;
    const res = await Promise.all(Array.from({ length: 12 }, () => jobRunner.acquireLease(key, 10)));
    expect(res.filter(Boolean)).toHaveLength(1);
  });

  it('the same (job, period_key) cannot run twice once ok; a failed run can be retried', async () => {
    const job = `friday_${randomUUID()}`;
    const first = await jobRunner.acquireLease(job, 10, '2026-W44');
    expect(first).toBeTruthy();
    await jobRunner.releaseLease(first!, 'ok');
    expect(await jobRunner.acquireLease(job, 10, '2026-W44')).toBeNull();
    expect(await jobRunner.acquireLease(job, 10, '2026-W45')).toBeTruthy();

    const job2 = `friday_${randomUUID()}`;
    const f = await jobRunner.acquireLease(job2, 10, '2026-W44');
    await jobRunner.releaseLease(f!, 'failed', { error: 'boom' });
    expect(await jobRunner.acquireLease(job2, 10, '2026-W44')).toBeTruthy();
  });

  it('period_key is persisted (schema drift regression)', async () => {
    const job = `pk_${randomUUID()}`;
    const id = await jobRunner.acquireLease(job, 10, '2026-W50');
    const row = (await q(`select period_key, lease_key from job_runs where id=$1`, [id])).rows[0];
    expect(row.period_key).toBe('2026-W50');
    expect(row.lease_key).toBe(`${job}:2026-W50`);
  });

  it('reclaims an expired running lease atomically and marks the old run failed', async () => {
    const key = `stale_${randomUUID()}`;
    const old = randomUUID();
    await q(`insert into job_runs(id,job,status,lease_key,lease_expires_at) values ($1,$2,'running',$2, now() - interval '1 minute')`, [old, key]);
    const wins = await Promise.all(Array.from({ length: 8 }, () => jobRunner.acquireLease(key, 10)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect((await q(`select status from job_runs where id=$1`, [old])).rows[0].status).toBe('failed');
  });

  it('a live (unexpired) lease blocks others', async () => {
    const key = `live_${randomUUID()}`;
    expect(await jobRunner.acquireLease(key, 10)).toBeTruthy();
    expect(await jobRunner.acquireLease(key, 10)).toBeNull();
  });

  it('a real DB error throws instead of silently skipping the job', async () => {
    await q(`alter table job_runs rename column lease_key to lease_key_x`);
    try {
      await expect(jobRunner.acquireLease(`err_${randomUUID()}`, 10)).rejects.toThrow();
    } finally {
      await q(`alter table job_runs rename column lease_key_x to lease_key`);
    }
  });

  it('releaseLease surfaces its own error', async () => {
    await q(`alter table job_runs rename column finished_at to finished_at_x`);
    try {
      const id = randomUUID();
      await expect(jobRunner.releaseLease(id, 'ok')).rejects.toThrow();
    } finally {
      await q(`alter table job_runs rename column finished_at_x to finished_at`);
    }
  });
});
