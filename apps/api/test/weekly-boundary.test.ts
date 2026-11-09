import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { getLocalMondayStart, approvalsRepo } from '../src/repos/approvals.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { WEEK_TEST_ZONES, weekTestInstants } from './helpers/zones.js';

/**
 * C5: the weekly cap resets at Monday 00:00 in the USER's timezone. Verified against an INDEPENDENT ground truth
 * (scan backwards for the instant whose local wall clock reads Monday 00:00:00), not against the implementation's own
 * arithmetic, across awkward zones and DST weeks, and with a fake clock end to end.
 */
const ZONES = WEEK_TEST_ZONES;

function localParts(t: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(t));
  const get = (k: string) => parts.find((p) => p.type === k)!.value;
  return { weekday: get('weekday'), h: Number(get('hour')), m: Number(get('minute')), s: Number(get('second')) };
}
/** Latest instant <= now whose local time is exactly Monday 00:00:00. All zone offsets are multiples of 15 minutes. */
function groundTruthMonday(now: number, tz: string): number {
  const STEP = 15 * 60_000;
  for (let t = Math.floor(now / STEP) * STEP, i = 0; i < 8 * 96; t -= STEP, i++) {
    const p = localParts(t, tz);
    if (p.weekday === 'Mon' && p.h === 0 && p.m === 0 && p.s === 0) return t;
  }
  throw new Error(`no Monday midnight found for ${tz}`);
}
describe('getLocalMondayStart vs an independent ground truth', () => {
  it('matches the true Monday-00:00-local instant for every zone and instant (including DST weeks)', () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const tz of ZONES) {
      for (const now of weekTestInstants()) {
        const got = getLocalMondayStart(new Date(now), tz).getTime();
        const want = groundTruthMonday(now, tz);
        checked++;
        if (got !== want) mismatches.push(`${tz} now=${new Date(now).toISOString()} got=${new Date(got).toISOString()} want=${new Date(want).toISOString()} (${(got - want) / 60_000} min)`);
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(mismatches).toEqual([]);
  }, 120_000);
});

describe('weekly cap window with a fake clock', () => {
  const userId = '00000000-0000-4000-a000-000000000001';
  beforeEach(() => { initLocalSeed(); localDb.approvals.clear(); });
  afterEach(() => vi.useRealTimers());

  const seedExecuted = (iso: string, moneyOut: number) => {
    const id = crypto.randomUUID();
    localDb.approvals.set(id, { id, user_id: userId, status: 'executed', executed_at: iso, money_out_minor: moneyOut, action_type: 'vault_move' } as never);
  };

  it('Kolkata resets at its own Monday 00:00 (18:30 UTC Sunday), not UTC or Los Angeles', async () => {
    seedExecuted('2026-11-08T18:29:59.999Z', 1000); // Sunday 23:59:59.999 in Kolkata: still the OLD week once Monday starts
    seedExecuted('2026-11-08T18:30:00.000Z', 400); // exactly Monday 00:00:00.000 in Kolkata: the NEW week
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T18:29:59.999Z')); // last instant of the old week
    expect(await approvalsRepo.getExecutedThisWeekTotal(userId, 'Asia/Kolkata')).toBe(1000);
    vi.setSystemTime(new Date('2026-11-08T18:30:00.000Z')); // week rolls over
    expect(await approvalsRepo.getExecutedThisWeekTotal(userId, 'Asia/Kolkata')).toBe(400);
  });

  it('the same instant is a different week for people in different zones', async () => {
    // Sunday 2026-11-08 20:00 UTC: Kolkata already Monday (01:30), Los Angeles still Sunday (12:00).
    seedExecuted('2026-11-04T12:00:00.000Z', 5000); // Wednesday, executed earlier in the week
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T20:00:00.000Z'));
    expect(await approvalsRepo.getExecutedThisWeekTotal(userId, 'America/Los_Angeles')).toBe(5000); // same week as Wed
    expect(await approvalsRepo.getExecutedThisWeekTotal(userId, 'Asia/Kolkata')).toBe(0); // new week, cap reset
  });

  it('a US DST change inside the week does not shift the boundary by an hour', async () => {
    // US clocks fell back on Sun 2026-11-01. Monday 2026-11-02 00:00 PST = 08:00 UTC.
    seedExecuted('2026-11-02T07:59:59.999Z', 700);
    seedExecuted('2026-11-02T08:00:00.000Z', 300);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T08:00:00.000Z'));
    expect(await approvalsRepo.getExecutedThisWeekTotal(userId, 'America/Los_Angeles')).toBe(300);
    vi.setSystemTime(new Date('2026-11-02T07:59:59.999Z'));
    expect(await approvalsRepo.getExecutedThisWeekTotal(userId, 'America/Los_Angeles')).toBe(700);
  });

  it('only counts executed approvals of this user', async () => {
    seedExecuted('2026-11-04T12:00:00.000Z', 100);
    const other = crypto.randomUUID();
    localDb.approvals.set(other, { id: other, user_id: 'someone-else', status: 'executed', executed_at: '2026-11-04T12:00:00.000Z', money_out_minor: 9999 } as never);
    const pending = crypto.randomUUID();
    localDb.approvals.set(pending, { id: pending, user_id: userId, status: 'pending', executed_at: '2026-11-04T12:00:00.000Z', money_out_minor: 9999 } as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
    expect(await approvalsRepo.getExecutedThisWeekTotal(userId, 'UTC')).toBe(100);
  });

  it.each(['Mars/Olympus', 'not a zone', ''])('rejects the invalid timezone %j instead of silently using UTC', async (tz) => {
    await expect(approvalsRepo.getExecutedThisWeekTotal(userId, tz)).rejects.toThrow(/Invalid timezone/);
  });
});
