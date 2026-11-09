import { describe, it, expect } from 'vitest';
import { q, seedProfile, insertApproval } from './helpers.js';

// Fixed "now": Thursday 2026-11-05T10:00:00Z. Monday-midnight boundaries (hard-coded, independent of the SQL under test):
//   Asia/Kolkata        Mon 2026-11-02 00:00 +05:30 = 2026-11-01T18:30:00Z
//   America/Los_Angeles Mon 2026-11-02 00:00 -08:00 (DST ended Sun Nov 1) = 2026-11-02T08:00:00Z
//   UTC                 2026-11-02T00:00:00Z
const NOW = '2026-11-05T10:00:00Z';
const CASES: Array<[string, string]> = [
  ['Asia/Kolkata', '2026-11-01T18:30:00Z'],
  ['America/Los_Angeles', '2026-11-02T08:00:00Z'],
  ['UTC', '2026-11-02T00:00:00Z']
];
const shift = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

describe('weekly_money_out_for (A5)', () => {
  for (const [tz, boundary] of CASES) {
    it(`${tz}: counts executions after local Monday 00:00, not before`, async () => {
      const uid = await seedProfile({ tz });
      await insertApproval(uid, { status: 'executed', money: 100, executedAt: shift(boundary, -60_000) }); // last week
      await insertApproval(uid, { status: 'executed', money: 7, executedAt: shift(boundary, +60_000) });   // this week
      await insertApproval(uid, { status: 'executed', money: 5, executedAt: boundary });                  // exactly on boundary => this week
      await insertApproval(uid, { status: 'pending', money: 999 });
      await insertApproval(uid, { status: 'failed', money: 999 });
      const r = await q(`select weekly_money_out_for($1,$2,$3::timestamptz) as total`, [uid, tz, NOW]);
      expect(Number(r.rows[0].total)).toBe(12);
    });
  }

  it('the old UTC-week view would disagree with the tz-aware function (proves the fix matters)', async () => {
    const uid = await seedProfile({ tz: 'America/Los_Angeles' });
    // Sun 23:00 PST == Mon 07:00Z; in UTC this is "this week", in LA it is LAST week.
    await insertApproval(uid, { status: 'executed', money: 50, executedAt: '2026-11-02T07:00:00Z' });
    const r = await q(`select weekly_money_out_for($1,'America/Los_Angeles',$2::timestamptz) as total`, [uid, NOW]);
    expect(Number(r.rows[0].total)).toBe(0);
  });

  it('rejects an invalid timezone instead of silently using UTC', async () => {
    const uid = await seedProfile();
    await expect(q(`select weekly_money_out_for($1,'Not/AZone')`, [uid])).rejects.toThrow();
  });
});
