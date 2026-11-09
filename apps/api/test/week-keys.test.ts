import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { getIsoWeekKey, getLocalDateKey, jobRunner, PROFILE_PAGE_SIZE } from '../src/jobs/runner.js';
import { getLocalMondayStart } from '../src/repos/approvals.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { vaultRepo } from '../src/repos/vault.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { orchestratorAgent } from '../src/agents/orchestrator.js';
import { learnerAgent } from '../src/agents/learner.js';
import { WEEK_TEST_ZONES } from './helpers/zones.js';

/**
 * C5: week keys follow the USER's local calendar (a UTC key puts a Pacific/Auckland Monday morning in the previous
 * week), the scheduler fires jobs in local time with local keys, pages through every profile, and records a lease as
 * 'failed' when a job throws. Fake clocks for Asia/Kolkata, America/Los_Angeles and Pacific/Auckland.
 */
const userId = '00000000-0000-4000-a000-000000000001';
const at = (iso: string) => new Date(iso);

describe('getIsoWeekKey / getLocalDateKey are local-calendar based', () => {
  it('Pacific/Auckland: Monday 00:00 NZDT is the NEW week even though it is still Sunday in UTC', () => {
    // 2026-11-08T11:00:00Z = Mon 2026-11-09 00:00 NZDT (UTC+13)
    expect(getIsoWeekKey(at('2026-11-08T10:59:59.999Z'), 'Pacific/Auckland')).toBe('2026-W45');
    expect(getIsoWeekKey(at('2026-11-08T11:00:00.000Z'), 'Pacific/Auckland')).toBe('2026-W46');
    expect(getIsoWeekKey(at('2026-11-08T11:00:00.000Z'))).toBe('2026-W45'); // the old UTC behaviour was wrong here
    expect(getLocalDateKey(at('2026-11-08T11:00:00.000Z'), 'Pacific/Auckland')).toBe('2026-11-09');
    expect(getLocalDateKey(at('2026-11-08T11:00:00.000Z'), 'UTC')).toBe('2026-11-08');
  });

  it('Asia/Kolkata: the week turns at 18:30 UTC Sunday (Monday 00:00 IST)', () => {
    expect(getIsoWeekKey(at('2026-11-08T18:29:59.999Z'), 'Asia/Kolkata')).toBe('2026-W45');
    expect(getIsoWeekKey(at('2026-11-08T18:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-W46');
  });

  it('America/Los_Angeles: Sunday 17:00 PST is still the OLD week even though it is Monday in UTC', () => {
    // 2026-11-09T01:00:00Z = Sun 2026-11-08 17:00 PST
    expect(getIsoWeekKey(at('2026-11-09T01:00:00.000Z'), 'America/Los_Angeles')).toBe('2026-W45');
    expect(getIsoWeekKey(at('2026-11-09T01:00:00.000Z'))).toBe('2026-W46'); // UTC would say next week
    expect(getIsoWeekKey(at('2026-11-09T08:00:00.000Z'), 'America/Los_Angeles')).toBe('2026-W46'); // Mon 00:00 PST
  });

  it('follows ISO year boundaries (2026 has 53 weeks) in the local calendar', () => {
    // Auckland Mon 2027-01-04 00:00 NZDT = 2027-01-03T11:00Z; in UTC that instant is still Sunday of 2026-W53.
    expect(getIsoWeekKey(at('2027-01-03T10:59:59.999Z'), 'Pacific/Auckland')).toBe('2026-W53');
    expect(getIsoWeekKey(at('2027-01-03T11:00:00.000Z'), 'Pacific/Auckland')).toBe('2027-W01');
    expect(getIsoWeekKey(at('2027-01-03T11:00:00.000Z'))).toBe('2026-W53');
    expect(getIsoWeekKey(at('2026-01-01T12:00:00.000Z'))).toBe('2026-W01');
    expect(getIsoWeekKey(at('2025-12-29T12:00:00.000Z'))).toBe('2026-W01'); // Mon Dec 29 2025 belongs to 2026-W01
  });

  it('an unknown zone falls back to UTC instead of throwing', () => {
    expect(getIsoWeekKey(at('2026-11-08T11:00:00.000Z'), 'Mars/Olympus')).toBe('2026-W45');
    expect(getLocalDateKey(at('2026-11-08T11:00:00.000Z'), 'Mars/Olympus')).toBe('2026-11-08');
  });

  it('for every zone the key is constant across the local week and changes exactly at local Monday 00:00 (DST weeks included)', () => {
    const DAY = 86_400_000;
    for (const tz of WEEK_TEST_ZONES) {
      for (const probe of [Date.UTC(2026, 2, 12), Date.UTC(2026, 9, 28), Date.UTC(2026, 10, 3), Date.UTC(2026, 11, 29)]) {
        const monday = getLocalMondayStart(new Date(probe), tz).getTime();
        const next = getLocalMondayStart(new Date(monday + 7 * DAY + 12 * 3_600_000), tz).getTime();
        const key = (t: number) => getIsoWeekKey(new Date(t), tz);
        expect(key(monday - 1), `${tz} just before`).not.toBe(key(monday));
        expect(key(monday + 3 * DAY), tz).toBe(key(monday));
        expect(key(next - 1), `${tz} last ms`).toBe(key(monday));
        expect(key(next), `${tz} next Monday`).not.toBe(key(monday));
      }
    }
  });
});

describe('mood check-ins land in the user\'s local week', () => {
  beforeEach(() => { initLocalSeed(); localDb.mood_checkins.clear(); });
  afterEach(() => vi.useRealTimers());
  const setTz = (tz: string) => { localDb.profiles.get(userId)!.timezone = tz; };

  it('an Auckland Monday-morning check-in is this week, and does not collide with last week\'s', async () => {
    setTz('Pacific/Auckland');
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-11-08T10:59:00Z')); // Sunday 23:59 NZDT
    const sunday = await vaultRepo.saveMoodCheckin(userId, 'drained');
    vi.setSystemTime(at('2026-11-08T11:01:00Z')); // Monday 00:01 NZDT
    const monday = await vaultRepo.saveMoodCheckin(userId, 'great');
    expect(sunday.week).toBe('2026-W45');
    expect(monday.week).toBe('2026-W46');
    expect(monday.id).not.toBe(sunday.id); // a separate row: the new week did not overwrite the old one
    expect(localDb.mood_checkins.size).toBe(2);
  });

  it('a Los Angeles Sunday-evening check-in is stamped with the week that is still running', async () => {
    setTz('America/Los_Angeles');
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-11-09T01:00:00Z')); // Sunday 17:00 PST, Monday in UTC
    expect((await vaultRepo.saveMoodCheckin(userId, 'okay')).week).toBe('2026-W45');
  });

  it('a second check-in in the same local week updates it instead of adding a row', async () => {
    setTz('Asia/Kolkata');
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-11-09T05:00:00Z'));
    const a = await vaultRepo.saveMoodCheckin(userId, 'okay');
    vi.setSystemTime(at('2026-11-12T05:00:00Z'));
    const b = await vaultRepo.saveMoodCheckin(userId, 'great');
    expect(b.id).toBe(a.id);
    expect(b.level).toBe('great');
    expect(localDb.mood_checkins.size).toBe(1);
  });
});

describe('scheduler fires in local time with local keys', () => {
  const profile = () => ({ ...localDb.profiles.get(userId)! });
  // `job` is the lease name without its period suffix (lease_key is `${job}:${period}`).
  const leaseKeys = () => [...localDb.job_runs.values()].map((r) => r.job).filter(Boolean) as string[];
  beforeEach(() => { initLocalSeed(); localDb.job_runs.clear(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const run = (tz: string, iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(at(iso));
    return jobRunner.processUserSchedule({ ...profile(), timezone: tz });
  };

  it.each([
    ['Pacific/Auckland', '2026-11-08T11:30:00Z', '2026-W46'], // Mon 00:30 NZDT
    ['Asia/Kolkata', '2026-11-08T18:45:00Z', '2026-W46'], // Mon 00:15 IST
    ['America/Los_Angeles', '2026-11-09T08:30:00Z', '2026-W46'] // Mon 00:30 PST
  ])('%s: the Monday reset runs at local Monday 00:xx under the LOCAL week key', async (tz, iso, week) => {
    localDb.pockets.set(`${userId}:weekly`, { user_id: userId, kind: 'weekly', balance_minor: 0, target_minor: null, is_simulated: false } as never);
    await run(tz, iso);
    expect(leaseKeys()).toContain(`monday_reset_${userId}_${week}`);
    expect((await vaultRepo.getPocket(userId, 'weekly'))?.balance_minor).toBe(profile().guilt_free_cap_minor);
  });

  it('does NOT run the Monday reset for someone whose local time is still Sunday night', async () => {
    await run('America/Los_Angeles', '2026-11-09T07:30:00Z'); // Sun 23:30 PST, but 07:30 UTC Monday
    expect(leaseKeys().some((k) => k.startsWith('monday_reset_'))).toBe(false);
  });

  it('the daily decay job is keyed by the LOCAL date, once per local day', async () => {
    const decay = vi.spyOn(learnerAgent, 'decay').mockResolvedValue(undefined as never);
    await run('Pacific/Auckland', '2026-11-08T11:10:00Z'); // 2026-11-09 00:10 local
    await jobRunner.processUserSchedule({ ...profile(), timezone: 'Pacific/Auckland' }); // same hour again
    expect(leaseKeys()).toContain(`decay_${userId}_2026-11-09`); // UTC date would be 2026-11-08
    expect(decay).toHaveBeenCalledTimes(1);
  });

  it('Friday 17:00 local fires the briefing once per local week', async () => {
    const note = vi.spyOn(orchestratorAgent, 'postProactiveNote').mockResolvedValue(undefined as never);
    await run('Asia/Kolkata', '2026-11-13T11:30:00Z'); // Fri 17:00 IST
    await jobRunner.processUserSchedule({ ...profile(), timezone: 'Asia/Kolkata' });
    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(userId, 'friday_brief');
    expect(leaseKeys()).toContain(`friday_brief_${userId}_2026-W46`);
  });

  describe('a throwing job records its lease as failed, in a finally', () => {
    it('marks the lease failed (not left running) and surfaces the error', async () => {
      vi.spyOn(orchestratorAgent, 'postProactiveNote').mockRejectedValue(new Error('gemini exploded'));
      await expect(run('Asia/Kolkata', '2026-11-13T11:30:00Z')).rejects.toThrow('gemini exploded');
      const lease = [...localDb.job_runs.values()].find((r) => r.job?.startsWith('friday_brief_'))!;
      expect(lease.status).toBe('failed');
      expect(lease.finished_at).toBeTruthy();
      expect(lease.detail).toMatchObject({ error: 'gemini exploded' });
      expect([...localDb.job_runs.values()].some((r) => r.status === 'running')).toBe(false);
    });

    it('a failed run can be retried in the same period (and then succeeds exactly once)', async () => {
      const note = vi.spyOn(orchestratorAgent, 'postProactiveNote').mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined as never);
      await expect(run('Asia/Kolkata', '2026-11-13T11:30:00Z')).rejects.toThrow('boom');
      await jobRunner.processUserSchedule({ ...profile(), timezone: 'Asia/Kolkata' }); // retry
      await jobRunner.processUserSchedule({ ...profile(), timezone: 'Asia/Kolkata' }); // now deduplicated
      expect(note).toHaveBeenCalledTimes(2); // 1 failed + 1 successful, not 3
      const statuses = [...localDb.job_runs.values()].filter((r) => r.job?.startsWith('friday_brief_')).map((r) => r.status).sort();
      expect(statuses).toEqual(['failed', 'ok']);
    });

    it('does not mask the job error if recording the outcome itself fails', async () => {
      vi.spyOn(orchestratorAgent, 'postProactiveNote').mockRejectedValue(new Error('real failure'));
      vi.spyOn(jobRunner, 'releaseLease').mockRejectedValue(new Error('db down'));
      await expect(run('Asia/Kolkata', '2026-11-13T11:30:00Z')).rejects.toThrow('real failure');
    });
  });
});

describe('profile paging (no silent truncation)', () => {
  beforeEach(() => {
    initLocalSeed();
    localDb.profiles.clear();
    for (let i = 0; i < 450; i++) {
      const id = crypto.randomUUID();
      localDb.profiles.set(id, { id, name: `U${i}`, timezone: 'UTC', guilt_free_cap_minor: 1000 } as never);
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('visits every profile exactly once, in id order, in pages of at most 200', async () => {
    const sizes: number[] = [];
    const ids: string[] = [];
    const total = await profilesRepo.forEachPage(200, async (page) => { sizes.push(page.length); ids.push(...page.map((p) => p.id)); });
    expect(total).toBe(450);
    expect(sizes).toEqual([200, 200, 50]);
    expect(new Set(ids).size).toBe(450);
    expect(ids).toEqual([...ids].sort());
  });

  it('handles an exact multiple of the page size, a single page, and no rows', async () => {
    const sizes: number[] = [];
    for (const id of [...localDb.profiles.keys()].slice(400)) localDb.profiles.delete(id); // 400 left
    await profilesRepo.forEachPage(200, async (p) => { sizes.push(p.length); });
    expect(sizes).toEqual([200, 200]);
    localDb.profiles.clear();
    expect(await profilesRepo.forEachPage(200, async () => { throw new Error('should not be called'); })).toBe(0);
  });

  it('rejects an invalid page size', async () => {
    for (const bad of [0, -1, 1.5, NaN]) await expect(profilesRepo.forEachPage(bad, async () => {})).rejects.toThrow(/pageSize/);
  });

  it('getAll returns everyone (not just the first page)', async () => {
    expect((await profilesRepo.getAll()).length).toBe(450);
  });

  it('the hourly sweep processes ALL users, and one user failing does not stop the rest', async () => {
    const seen: string[] = [];
    vi.spyOn(jobRunner, 'processUserSchedule').mockImplementation(async (p) => {
      seen.push(p.id);
      if (seen.length === 7) throw new Error('one bad user');
    });
    await jobRunner.runHourlyUserSweep();
    expect(seen.length).toBe(450);
    expect(new Set(seen).size).toBe(450);
    const sweep = [...localDb.job_runs.values()].find((r) => r.job === 'hourly_user_sweep');
    expect(sweep?.status).toBe('ok');
    expect(sweep?.detail).toMatchObject({ processedUsers: 450 });
    expect(PROFILE_PAGE_SIZE).toBe(200);
  });
});
