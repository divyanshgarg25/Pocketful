import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { approvalsRepo } from '../src/repos/approvals.js';
import { guardianAgent } from '../src/agents/guardian.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { enrollTestPin, stepUp, TEST_PIN } from './helpers/stepup.js';

interface R<T> { ok: boolean; data: T; error?: { code: string; message: string } }

describe('Execution integrity: step-up, execute-time caps, retry, no double-run', () => {
  let server: Server;
  let baseUrl: string;
  const userId = '00000000-0000-4000-a000-000000000001';
  let token: string;
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const call = async <T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(baseUrl + path, { method, headers: { ...H(), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as R<T> };
  };
  let keySeq = 0;
  const key = () => `itest_${Date.now()}_${++keySeq}_${crypto.randomBytes(4).toString('hex')}`;

  const stage = async (amountMinor: number) => {
    const r = await call<{ approval: { id: string } }>('POST', '/api/vault/decide', { action: 'roll_over', amountMinor });
    expect(r.status).toBe(200);
    return r.json.data.approval.id;
  };
  const challenge = async (id: string) => (await call<{ challengeNonce: string }>('POST', `/api/approvals/${id}/challenge`)).json.data;
  const approve = async (id: string, body?: Record<string, unknown>) => {
    const c = body ? null : await challenge(id);
    return call<{ status: string }>('POST', `/api/approvals/${id}/decide`, { decision: 'approve', ...(body ?? stepUp(c!)) }, { 'Idempotency-Key': key() });
  };
  const setCaps = async (perAction: number, weekly: number) => {
    const p = localDb.profiles.get(userId)!;
    localDb.profiles.set(userId, { ...p, per_action_cap_minor: perAction, weekly_cap_minor: weekly });
  };

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
  beforeEach(async () => {
    initLocalSeed();
    localDb.approvals.clear();
    localDb.step_up.clear();
    vi.restoreAllMocks();
    await enrollTestPin(baseUrl, token);
  });

  // ---- C5 / D4 -------------------------------------------------------------
  it('rejects the previously-forgeable sha256(nonce:hash) proof, and returns nothing a client could derive a proof from', async () => {
    const id = await stage(500);
    const c = await call<Record<string, unknown>>('POST', `/api/approvals/${id}/challenge`);
    expect(Object.keys(c.json.data).sort()).toEqual(['challengeNonce', 'expiresAt', 'methods']);
    const nonce = c.json.data['challengeNonce'] as string;
    for (const guess of [nonce, crypto.createHash('sha256').update(`${nonce}:${id}`).digest('hex')]) {
      const r = await approve(id, { stepUpProof: guess });
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe('STEP_UP_REQUIRED');
    }
    expect((await call('GET', `/api/approvals/${id}`)).json.data).toMatchObject({ approval: { status: 'pending' } });
  });

  it('refuses to approve when no step-up PIN is enrolled', async () => {
    localDb.step_up.clear();
    const id = await stage(500);
    const c = await call('POST', `/api/approvals/${id}/challenge`);
    expect(c.status).toBe(403);
    expect(c.json.error?.code).toBe('STEP_UP_NOT_ENROLLED');
    const r = await approve(id, { proof: { method: 'pin', pin: TEST_PIN }, challengeNonce: 'x'.repeat(48) });
    expect(r.json.error?.code).toBe('STEP_UP_NOT_ENROLLED');
  });

  it('a nonce issued for approval A cannot approve approval B', async () => {
    const a = await stage(500);
    const b = await stage(501);
    const ca = await challenge(a);
    await challenge(b);
    const r = await approve(b, { proof: { method: 'pin', pin: TEST_PIN }, challengeNonce: ca.challengeNonce });
    expect(r.status).toBe(403);
    expect(r.json.error?.code).toBe('STEP_UP_CHALLENGE_INVALID');
  });

  it('wrong PIN is rejected, then 5 failures lock the factor even for the right PIN', async () => {
    const id = await stage(500);
    const c = await challenge(id);
    for (let i = 0; i < 4; i++) {
      expect((await approve(id, { proof: { method: 'pin', pin: '135792' }, challengeNonce: c.challengeNonce })).json.error?.code).toBe('STEP_UP_FAILED');
    }
    expect((await approve(id, { proof: { method: 'pin', pin: '135792' }, challengeNonce: c.challengeNonce })).json.error?.code).toBe('STEP_UP_LOCKED');
    expect((await approve(id, { proof: { method: 'pin', pin: TEST_PIN }, challengeNonce: c.challengeNonce })).json.error?.code).toBe('STEP_UP_LOCKED');
  });

  it('nonce is single-use and tampering with the approval after the challenge invalidates it', async () => {
    const id = await stage(500);
    const c = await challenge(id);
    const rec = localDb.approvals.get(id)!;
    localDb.approvals.set(id, { ...rec, amount_minor: rec.amount_minor + 1 });
    const r = await approve(id, { proof: { method: 'pin', pin: TEST_PIN }, challengeNonce: c.challengeNonce });
    expect(r.status).toBe(403);
    expect(r.json.error?.code).toBe('STEP_UP_CHALLENGE_INVALID');
  });

  // ---- B3 ------------------------------------------------------------------
  it('weekly cap is enforced at EXECUTION time (staged-under-cap approvals cannot jointly exceed it)', async () => {
    await setCaps(6000, 6000);
    const ids = [await stage(4000), await stage(4001), await stage(4002)]; // each passes at staging
    const results = [];
    for (const id of ids) results.push(await approve(id));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    const blocked = results.filter((r) => r.status !== 200);
    expect(blocked.length).toBe(2);
    expect(blocked[0]!.json.error?.code).toBe('GUARDIAN_BLOCKED');
    const executed = [...localDb.approvals.values()].filter((a) => a.user_id === userId && a.status === 'executed' && a.action_type === 'vault_move');
    expect(executed.reduce((s, a) => s + (a.money_out_minor ?? 0), 0)).toBeLessThanOrEqual(6000);
  });

  it('parallel approvals can never jointly exceed the weekly cap', async () => {
    await setCaps(5000, 7000);
    const ids = await Promise.all([1, 2, 3, 4, 5].map((i) => stage(3000 + i)));
    const challenges = await Promise.all(ids.map((id) => challenge(id)));
    const results = await Promise.all(
      ids.map((id, i) => call('POST', `/api/approvals/${id}/decide`, { decision: 'approve', ...stepUp(challenges[i]!) }, { 'Idempotency-Key': key() }))
    );
    expect(results.filter((r) => r.status === 200).length).toBe(2); // 2 x ~3000 <= 7000, 3rd would be 9000+
    const total = [...localDb.approvals.values()]
      .filter((a) => a.user_id === userId && (a.status === 'executed' || a.status === 'executing') && a.action_type === 'vault_move')
      .reduce((s, a) => s + (a.money_out_minor ?? 0), 0);
    expect(total).toBeLessThanOrEqual(7000);
  });

  it('lowering caps after staging blocks execution; zero cap locks it', async () => {
    const id = await stage(3000);
    await setCaps(2000, 50000);
    const r = await approve(id);
    expect(r.status).toBe(422);
    expect(r.json.error?.code).toBe('GUARDIAN_BLOCKED');
    const id2 = await stage(100);
    await setCaps(0, 0);
    expect((await approve(id2)).json.error?.code).toBe('GUARDIAN_BLOCKED');
  });

  // ---- B2 ------------------------------------------------------------------
  const seedFailed = (over: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    localDb.approvals.set(id, {
      id, user_id: userId, action_type: 'vault_move', payload: { action: 'roll_over' }, preview: 'x',
      amount_minor: 500, money_out_minor: 500, status: 'failed', idempotency_key: key(), retry_count: 0,
      result: { error: 'EXECUTION_FAILED' }, decided_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600000).toISOString(), ...over
    } as never);
    return id;
  };

  it('retry without step-up is rejected even when no nonce is stored', async () => {
    const id = seedFailed();
    const r = await call('POST', `/api/approvals/${id}/retry`, {});
    expect(r.status).toBe(403);
    expect(localDb.approvals.get(id)!.status).toBe('failed');
  });

  it('retry refuses approvals that already performed their side effect, exhausted retries, or are past 24h', async () => {
    const a = seedFailed({ execution_outcome: { ok: true } });
    expect((await call('POST', `/api/approvals/${a}/retry`, {})).json.error?.code).toBe('ALREADY_EXECUTED');
    const b = seedFailed({ retry_count: 3 });
    expect((await call('POST', `/api/approvals/${b}/retry`, {})).json.error?.code).toBe('RETRY_LIMIT');
    const c = seedFailed({ decided_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    expect((await call('POST', `/api/approvals/${c}/retry`, {})).status).toBe(410);
  });

  it('retry re-checks current caps', async () => {
    const id = seedFailed({ money_out_minor: 3000, amount_minor: 3000 });
    await setCaps(1000, 1000);
    const ch = await challenge(id);
    const r = await call('POST', `/api/approvals/${id}/retry`, stepUp(ch));
    expect(r.json.error?.code).toBe('GUARDIAN_BLOCKED');
    expect(localDb.approvals.get(id)!.status).toBe('failed');
  });

  // ---- B7 ------------------------------------------------------------------
  it('a failure AFTER the side effect never marks the approval failed and never re-runs the executor', async () => {
    const id2 = await stage(501);
    const c2 = await challenge(id2);
    const user = (await profilesRepo.getById(userId))!;
    await approvalsRepo.updateStatus(id2, 'approved', undefined, userId, undefined, ['pending']);
    await approvalsRepo.beginExecution(id2, userId, ['approved']);
    let executorCalls = 0;
    const executor = async () => { executorCalls++; return { moved: true }; };
    const real = approvalsRepo.updateStatus.bind(approvalsRepo);
    vi.spyOn(approvalsRepo, 'updateStatus').mockImplementation(async (...args: Parameters<typeof real>) => {
      if (args[1] === 'executed') throw new Error('db blip');
      return real(...args);
    });
    await expect(guardianAgent.executeApprovedAction(id2, user, executor)).rejects.toThrow('db blip');
    vi.restoreAllMocks();
    expect(executorCalls).toBe(1);
    const rec = localDb.approvals.get(id2)!;
    expect(rec.status).toBe('executing');
    expect(rec.execution_outcome).toEqual({ moved: true });
    // and the retry endpoint cannot resurrect it
    const r = await call('POST', `/api/approvals/${id2}/retry`, { proof: { method: 'pin', pin: TEST_PIN }, challengeNonce: c2.challengeNonce });
    expect(r.status).toBe(400);
  });
});
