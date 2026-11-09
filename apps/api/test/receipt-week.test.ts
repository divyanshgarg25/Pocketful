import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';

const userId = '00000000-0000-4000-a000-000000000001';

describe('Receipt week resolution (D4)', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  const get = async (w: string) => {
    const r = await fetch(`${baseUrl}/api/receipt/${w}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, json: (await r.json()) as any };
  };
  const setTz = (tz: string) => localDb.profiles.set(userId, { ...localDb.profiles.get(userId)!, timezone: tz });

  beforeAll(async () => {
    initLocalSeed();
    token = await createDevToken(userId, 'aarav@pocketful.demo', 'Aarav Sharma');
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const a = server.address();
        if (a && typeof a === 'object') baseUrl = `http://localhost:${a.port}`;
        resolve();
      });
    });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(() => { initLocalSeed(); setTz('UTC'); });

  it('ISO week, any date in the week, and the Monday itself all resolve to the same week', async () => {
    const a = await get('2026-W44'); // Mon 2026-10-26
    const b = await get('2026-10-29');
    const c = await get('2026-10-26');
    for (const r of [a, b, c]) {
      expect(r.status).toBe(200);
      expect(r.json.data.receipt.week).toBe('2026-10-26');
      expect(r.json.data.receipt.weekStart).toBe('2026-10-26T00:00:00.000Z');
      expect(r.json.data.receipt.weekEnd).toBe('2026-11-02T00:00:00.000Z');
    }
  });

  it('rejects anything it cannot interpret instead of silently answering for the current week', async () => {
    for (const bad of ['garbage', '2026-13-40', '2026-W54', '2026-W00', '2027-W53', '26-10-26', '2026-02-30']) {
      const r = await get(bad);
      expect(r.status, bad).toBe(400);
    }
  });

  it('week boundaries follow the user timezone (matches the weekly-cap window)', async () => {
    setTz('Asia/Kolkata'); // UTC+5:30
    const k = await get('2026-W44');
    expect(k.json.data.receipt.weekStart).toBe('2026-10-25T18:30:00.000Z');
    setTz('America/Los_Angeles'); // PDT until 2026-11-01
    const la = await get('2026-W44');
    expect(la.json.data.receipt.weekStart).toBe('2026-10-26T07:00:00.000Z');
    // week containing the US DST change is 7 days + 1h, never a fixed 168h assumption
    const dst = await get('2026-W44');
    expect(new Date(dst.json.data.receipt.weekEnd).getTime()).toBe(new Date('2026-11-02T08:00:00.000Z').getTime());
  });

  it("'current' resolves to a week that contains now", async () => {
    const r = await get('current');
    const { weekStart, weekEnd } = r.json.data.receipt;
    expect(Date.parse(weekStart)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(weekEnd)).toBeGreaterThan(Date.now());
  });

  it('year-boundary ISO weeks resolve correctly', async () => {
    const r = await get('2026-W01'); // Mon 2025-12-29
    expect(r.json.data.receipt.week).toBe('2025-12-29');
    expect((await get('2020-W53')).status).toBe(200); // 2020 has 53 ISO weeks
  });
});
