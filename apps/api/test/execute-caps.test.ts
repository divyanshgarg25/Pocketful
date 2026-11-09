import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { localDb } from '../src/core/database.js';
import { enrollTestPin, stepUp } from './helpers/stepup.js';

let server: Server; let base = '';
beforeAll(async () => { await new Promise<void>((r) => { server = app.listen(0, () => { base = `http://localhost:${(server.address() as any).port}`; r(); }); }); });
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function mkUser(weekly: number, perAction: number) {
  const uid = crypto.randomUUID();
  const token = await createDevToken(uid, `${uid}@t.test`, 'T');
  await enrollTestPin(base, token);
  const h = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  await fetch(`${base}/api/me`, { headers: h });
  const p = localDb.profiles.get(uid)!;
  localDb.profiles.set(uid, { ...p, weekly_cap_minor: weekly, per_action_cap_minor: perAction });
  localDb.pockets.set(`${uid}:weekly`, { user_id: uid, kind: 'weekly', balance_minor: 1_000_000, is_simulated: true });
  const stage = async (amount: number) => {
    const r = await fetch(`${base}/api/vault/decide`, { method: 'POST', headers: { ...h, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ action: 'lock_in', amountMinor: amount }) });
    return ((await r.json()) as any).data.approval.id as string;
  };
  const decide = async (id: string) => {
    const c = (await (await fetch(`${base}/api/approvals/${id}/challenge`, { method: 'POST', headers: h })).json()) as any;
    const r = await fetch(`${base}/api/approvals/${id}/decide`, { method: 'POST', headers: { ...h, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ decision: 'approve', ...stepUp(c.data) }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { uid, stage, decide };
}

describe('B3 execute-time weekly cap', () => {
  it('reproduces the staged-then-approved-all bypass: cap 6000, three moves of ~4000 => 2nd is GUARDIAN_BLOCKED at execution', async () => {
    const u = await mkUser(6000, 5000);
    const ids = [await u.stage(4000), await u.stage(4001), await u.stage(4002)]; // all stage: nothing executed yet
    const r1 = await u.decide(ids[0]!);
    const r2 = await u.decide(ids[1]!);
    const r3 = await u.decide(ids[2]!);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe('GUARDIAN_BLOCKED');
    expect(r3.status).toBe(422);
    const executed = [...localDb.approvals.values()].filter((a) => a.user_id === u.uid && a.status === 'executed');
    expect(executed.reduce((s, a) => s + a.money_out_minor, 0)).toBeLessThanOrEqual(6000);
    // blocked approvals do not linger as `approved`
    expect([...localDb.approvals.values()].filter((a) => a.user_id === u.uid && a.status === 'approved')).toHaveLength(0);
  });

  it('parallel decides never exceed the weekly cap', async () => {
    const u = await mkUser(10000, 5000);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await u.stage(4000 + i));
    await Promise.all(ids.map((id) => u.decide(id)));
    const total = [...localDb.approvals.values()]
      .filter((a) => a.user_id === u.uid && (a.status === 'executed' || a.status === 'executing'))
      .reduce((s, a) => s + a.money_out_minor, 0);
    expect(total).toBeLessThanOrEqual(10000);
  });

  it('lowering the cap after staging blocks at execution (current caps, not staging-time caps)', async () => {
    const u = await mkUser(50000, 25000);
    const id = await u.stage(4000);
    const p = localDb.profiles.get(u.uid)!;
    localDb.profiles.set(u.uid, { ...p, per_action_cap_minor: 1000 });
    const r = await u.decide(id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('GUARDIAN_BLOCKED');
  });
});
