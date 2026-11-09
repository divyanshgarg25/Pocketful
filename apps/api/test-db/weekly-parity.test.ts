import './env.js';
import { describe, it, expect } from 'vitest';
import { q, seedProfile, insertApproval } from './helpers.js';
import { WEEK_TEST_ZONES, weekTestInstants } from '../test/helpers/zones.js';

const { getLocalMondayStart } = await import('../src/repos/approvals.js');

/**
 * C5: development/tests compute the weekly-cap boundary in JS; production computes it in SQL
 * (weekly_money_out_for). They must agree for every zone and instant, or caps would behave differently in prod.
 */
describe('weekly boundary: JS implementation == real Postgres function', () => {
  it('computes the identical Monday-00:00-local instant for every zone and instant (incl. DST weeks, +5:45, +14, 30-min DST)', async () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const tz of WEEK_TEST_ZONES) {
      for (const now of weekTestInstants()) {
        const js = getLocalMondayStart(new Date(now), tz).getTime();
        // the exact expression weekly_money_out_for uses (migration 005)
        const r = await q(`select (date_trunc('week', $1::timestamptz at time zone $2) at time zone $2) as s`, [new Date(now).toISOString(), tz]);
        const sql = (r.rows[0].s as Date).getTime();
        checked++;
        if (js !== sql) mismatches.push(`${tz} now=${new Date(now).toISOString()} js=${new Date(js).toISOString()} sql=${new Date(sql).toISOString()}`);
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('the real function counts a row exactly on the JS boundary and excludes one millisecond before it (all zones, DST fortnight)', async () => {
    const now = Date.UTC(2026, 9, 28, 13, 0); // Wed 2026-10-28: inside the Europe/Pacific DST-change fortnight
    for (const tz of WEEK_TEST_ZONES) {
      const boundary = getLocalMondayStart(new Date(now), tz).getTime();
      const uid = await seedProfile({ tz });
      await insertApproval(uid, { status: 'executed', money: 1000, executedAt: new Date(boundary - 1).toISOString() }); // last week
      await insertApproval(uid, { status: 'executed', money: 7, executedAt: new Date(boundary).toISOString() }); // this week
      const r = await q(`select weekly_money_out_for($1,$2,$3::timestamptz) as total`, [uid, tz, new Date(now).toISOString()]);
      expect(Number(r.rows[0].total), tz).toBe(7);
    }
  }, 120_000);
});
