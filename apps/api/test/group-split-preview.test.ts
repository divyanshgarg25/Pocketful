import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed } from '../src/core/database.js';
import { computeEqualSplit } from '../src/agents/splitter.js';
import { approvalsRepo } from '../src/repos/approvals.js';

/** E2: the equal-split preview the organizer sees must be EXACTLY what friends are asked to pay. */
describe('E2: equal-split preview parity', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  const userId = '00000000-0000-4000-a000-000000000001';

  beforeAll(async () => {
    initLocalSeed();
    token = await createDevToken(userId, 'aarav@pocketful.demo', 'Aarav Sharma');
    await new Promise<void>((r) => {
      server = app.listen(0, () => {
        const a = server.address();
        if (a && typeof a === 'object') baseUrl = `http://localhost:${a.port}`;
        r();
      });
    });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const post = async <T>(path: string, body: unknown, auth = true) => {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    return { status: res.status, json: (await res.json()) as { ok: boolean; data: T; error?: { code: string } } };
  };
  type Preview = { totalMinor: number; currency: string; friendShares: number[]; organizerShareMinor: number };
  const friends = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Friend ${i + 1}`, contact: `f${i + 1}@example.com` }));

  describe('computeEqualSplit (pure)', () => {
    it('always sums to the total, spreads by at most 1 minor unit, and never goes negative (3000 random cases)', () => {
      for (let i = 0; i < 3000; i++) {
        const total = 1 + Math.floor(Math.random() * 5_000_000);
        const n = 1 + Math.floor(Math.random() * 20);
        const { friendShares, organizerShareMinor } = computeEqualSplit(crypto.randomUUID(), total, n);
        const all = [...friendShares, organizerShareMinor];
        expect(friendShares).toHaveLength(n);
        expect(all.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(1);
        expect(Math.min(...all)).toBeGreaterThanOrEqual(total < n + 1 ? 0 : 1);
        expect(all.every(Number.isInteger)).toBe(true);
      }
    });

    it('is deterministic for the same organizer/total/friend count, and does not depend on any random id', () => {
      const org = crypto.randomUUID();
      const a = computeEqualSplit(org, 10_001, 6);
      for (let i = 0; i < 20; i++) expect(computeEqualSplit(org, 10_001, 6)).toEqual(a);
    });

    it('rotates the odd pennies fairly: every slot, including the organizer, gets the extra unit about remainder/participants of the time', () => {
      // 10_001 over 7 participants -> remainder 5, so each slot should win the extra unit ~5/7 (71%) of the time.
      const N = 2000;
      const extra = new Array<number>(7).fill(0);
      for (let i = 0; i < N; i++) {
        const { friendShares, organizerShareMinor } = computeEqualSplit(`organizer-${i}`, 10_001, 6);
        const all = [...friendShares, organizerShareMinor];
        const base = Math.floor(10_001 / 7);
        all.forEach((v, idx) => { if (v > base) extra[idx]! += 1; });
      }
      for (const [idx, count] of extra.entries()) {
        expect(count / N, `slot ${idx}`).toBeGreaterThan(0.62);
        expect(count / N, `slot ${idx}`).toBeLessThan(0.8);
      }
    });

    it('an evenly divisible bill gives everyone exactly the same amount', () => {
      const s = computeEqualSplit(crypto.randomUUID(), 12_000, 3);
      expect([...s.friendShares, s.organizerShareMinor]).toEqual([3000, 3000, 3000, 3000]);
    });
  });

  describe('POST /api/groups/preview', () => {
    it('returns shares in minor units with the organizer currency', async () => {
      const r = await post<Preview>('/api/groups/preview', { totalMinor: 10_001, friendCount: 2 });
      expect(r.status).toBe(200);
      expect(r.json.data.currency).toBe('USD');
      expect(r.json.data.friendShares).toHaveLength(2);
      expect(r.json.data.friendShares.reduce((a, b) => a + b, 0) + r.json.data.organizerShareMinor).toBe(10_001);
    });

    it('requires authentication', async () => {
      expect((await post('/api/groups/preview', { totalMinor: 1000, friendCount: 2 }, false)).status).toBe(401);
    });

    it.each([
      [{ totalMinor: 0, friendCount: 2 }],
      [{ totalMinor: -5, friendCount: 2 }],
      [{ totalMinor: 10.5, friendCount: 2 }],
      [{ totalMinor: '1000', friendCount: 2 }],
      [{ totalMinor: 1000, friendCount: 0 }],
      [{ totalMinor: 1000, friendCount: 21 }],
      [{ totalMinor: 1000, friendCount: 1.5 }],
      [{ totalMinor: 10_000_000_01, friendCount: 2 }],
      [{ friendCount: 2 }],
      [{}]
    ])('rejects %j', async (body) => {
      const r = await post('/api/groups/preview', body);
      expect(r.status).toBe(400);
      expect(r.json.error?.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('preview == what is actually staged', () => {
    // Includes bills that do NOT divide evenly: the only case where a preview could disagree with reality.
    const cases: Array<[number, number]> = [
      [10_001, 2], [10_001, 3], [10_000, 3], [7_500, 2], [9_999, 4], [100, 7], [3_333, 3], [19_999, 5],
      [1_001, 1], [12_345, 6], [20_000, 19], [5_000, 4], [4_999, 8], [17, 3], [2_501, 2]
    ];
    it.each(cases)('total %i with %i friends: staged payments, organizer share and preview all agree', async (total, n) => {
      const preview = await post<Preview>('/api/groups/preview', { totalMinor: total, friendCount: n });
      const staged = await post<{ approvalId: string; payments: Array<{ share_minor: number }> }>('/api/groups', {
        totalMinor: total,
        splitMode: 'equal',
        friends: friends(n)
      });
      expect(staged.status).toBe(200);
      // each friend, in submitted order
      expect(staged.json.data.payments.map((p) => p.share_minor)).toEqual(preview.json.data.friendShares);
      // organizer's share as recorded on the approval the Guardian evaluates
      const approval = await approvalsRepo.getById(staged.json.data.approvalId, userId);
      expect((approval?.payload as { organizerShareMinor: number }).organizerShareMinor).toBe(preview.json.data.organizerShareMinor);
      // and nothing is lost or invented
      const sum = staged.json.data.payments.reduce((a, p) => a + p.share_minor, 0) + preview.json.data.organizerShareMinor;
      expect(sum).toBe(total);
    });

    it('staging the same bill twice yields the same shares (no hidden randomness)', async () => {
      const a = await post<{ payments: Array<{ share_minor: number }> }>('/api/groups', { totalMinor: 10_001, splitMode: 'equal', friends: friends(3) });
      const b = await post<{ payments: Array<{ share_minor: number }> }>('/api/groups', { totalMinor: 10_001, splitMode: 'equal', friends: friends(3) });
      expect(a.json.data.payments.map((p) => p.share_minor)).toEqual(b.json.data.payments.map((p) => p.share_minor));
    });
  });
});
