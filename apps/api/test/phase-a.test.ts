import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { localDb } from '../src/core/database.js';
import { jobRunner } from '../src/jobs/runner.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { approvalsRepo } from '../src/repos/approvals.js';
import { auditRepo } from '../src/repos/audit.js';
import { groupsRepo } from '../src/repos/groups.js';
import { vaultRepo } from '../src/repos/vault.js';
import { erasedUsersRepo } from '../src/repos/erasedUsers.js';
import { moneyService } from '../src/services/money.js';
import { SUPPORTED_CURRENCIES } from '../src/core/currency.js';
import type { Approval } from '../src/schemas/domain.js';

let server: Server;
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => { server = app.listen(0, () => { base = `http://localhost:${(server.address() as any).port}`; r(); }); });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function api(path: string, uid: string, init: RequestInit = {}) {
  const token = await createDevToken(uid, `${uid}@t.test`, 'Tester');
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

describe('A3 local lease parity', () => {
  it('concurrent acquireLease: exactly one winner', async () => {
    const key = `lock_${crypto.randomUUID()}`;
    const res = await Promise.all(Array.from({ length: 12 }, () => jobRunner.acquireLease(key, 10)));
    expect(res.filter(Boolean)).toHaveLength(1);
  });
  it('same (job, period_key) cannot run twice after ok; failed can be retried', async () => {
    const job = `j_${crypto.randomUUID()}`;
    const a = await jobRunner.acquireLease(job, 10, '2026-W44');
    await jobRunner.releaseLease(a!, 'ok');
    expect(await jobRunner.acquireLease(job, 10, '2026-W44')).toBeNull();
    const b = await jobRunner.acquireLease(job, 10, '2026-W45');
    expect(b).toBeTruthy();
    await jobRunner.releaseLease(b!, 'failed');
    expect(await jobRunner.acquireLease(job, 10, '2026-W45')).toBeTruthy();
  });
  it('reclaims an expired running lease and marks the old run failed', async () => {
    const key = `stale_${crypto.randomUUID()}`;
    const old = crypto.randomUUID();
    localDb.job_runs.set(old, { id: old, job: key, lease_key: key, lease_expires_at: new Date(Date.now() - 60_000).toISOString(), started_at: new Date().toISOString(), status: 'running' });
    const wins = await Promise.all(Array.from({ length: 6 }, () => jobRunner.acquireLease(key, 10)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(localDb.job_runs.get(old)!.status).toBe('failed');
  });
});

describe('A5 local weekly total uses the user timezone', () => {
  // now = Thu 2026-11-05T10:00Z; local Monday-midnight boundaries as in the Postgres suite.
  const NOW = new Date('2026-11-05T10:00:00Z');
  const cases: Array<[string, string]> = [
    ['Asia/Kolkata', '2026-11-01T18:30:00Z'],
    ['America/Los_Angeles', '2026-11-02T08:00:00Z'],
    ['UTC', '2026-11-02T00:00:00Z']
  ];
  for (const [tz, boundary] of cases) {
    it(`${tz}: counts only executions at/after local Monday 00:00`, async () => {
      vi.useFakeTimers(); vi.setSystemTime(NOW);
      try {
        const uid = crypto.randomUUID();
        const mk = (money: number, at: string) => {
          const id = crypto.randomUUID();
          localDb.approvals.set(id, { id, user_id: uid, action_type: 'vault_move', payload: {}, preview: 'p', amount_minor: money, money_out_minor: money, status: 'executed', idempotency_key: id, expires_at: NOW.toISOString(), executed_at: at } as Approval);
        };
        const t = new Date(boundary).getTime();
        mk(100, new Date(t - 60_000).toISOString());
        mk(7, new Date(t + 60_000).toISOString());
        mk(5, boundary);
        expect(await approvalsRepo.getExecutedThisWeekTotal(uid, tz)).toBe(12);
      } finally { vi.useRealTimers(); }
    });
  }
  it('invalid timezone fails closed', async () => {
    await expect(approvalsRepo.getExecutedThisWeekTotal(crypto.randomUUID(), 'Not/AZone')).rejects.toThrow();
  });
});

describe('A2 local erasure parity + tombstone', () => {
  it('anonymises audit rows, deletes job_runs/webhook_events referencing the user, writes a tombstone', async () => {
    const uid = crypto.randomUUID();
    await profilesRepo.upsert({ id: uid, name: 'E', timezone: 'UTC', max_distance_km: 5, guilt_free_cap_minor: 1, per_action_cap_minor: 1, weekly_cap_minor: 1, currency: 'USD', opt_in_mood: false, opt_in_tracking: false, exploration_level: 'normal' });
    const groupId = crypto.randomUUID();
    localDb.groups.set(groupId, { id: groupId, organizer_id: uid, total_minor: 100, currency: 'USD', deadline: new Date().toISOString(), status: 'pending' });
    const payId = crypto.randomUUID();
    localDb.group_payments.set(payId, { id: payId, group_id: groupId, friend_name: 'F', contact: 'f@x.t', share_minor: 50, public_token: 't', status: 'paid' });
    localDb.webhook_events.set('evt_mine', { id: 'evt_mine', event_type: 'X', payload: { resource: { custom_id: `${groupId}:${payId}` } }, status: 'processed', created_at: new Date().toISOString() });
    localDb.webhook_events.set('evt_other', { id: 'evt_other', event_type: 'X', payload: { resource: { custom_id: 'someone-else' } }, status: 'processed', created_at: new Date().toISOString() });
    const jr = await jobRunner.acquireLease('friday_brief', 10, `${uid}:2026-W44`);
    expect(jr).toBeTruthy();
    const row = await auditRepo.log({ user_id: uid, agent: 'guardian', action: 'x', params: { secret: 'pii' }, result: { secret: 'pii' } });

    await profilesRepo.eraseUser(uid);

    const kept = localDb.audit_log.find((e) => e.id === row.id)!;
    expect(kept.user_id).toBeNull();
    expect(kept.params).toEqual({ redacted: true });
    expect(kept.result).toEqual({ redacted: true });
    expect(localDb.webhook_events.has('evt_mine')).toBe(false);
    expect(localDb.webhook_events.has('evt_other')).toBe(true);
    expect([...localDb.job_runs.values()].some((r) => (r.lease_key ?? '').includes(uid))).toBe(false);
    expect(localDb.erased_users.has(uid)).toBe(true);
  });

  it('a still-valid token for an erased user gets 401 ACCOUNT_ERASED and is NOT re-provisioned', async () => {
    const uid = crypto.randomUUID();
    const first = await api('/api/me', uid);
    expect(first.status).toBe(200);
    await profilesRepo.eraseUser(uid);
    erasedUsersRepo.resetCacheForTests();
    const after = await api('/api/me', uid);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('ACCOUNT_ERASED');
    expect(await profilesRepo.getById(uid)).toBeNull();
  });
});

describe('A4 local parity: viewed + mood', () => {
  it('markPaymentViewed: sent -> viewed, never from other statuses, and does not mutate earlier snapshots', async () => {
    const mk = (status: any) => { const id = crypto.randomUUID(); localDb.group_payments.set(id, { id, group_id: crypto.randomUUID(), friend_name: 'f', contact: `${id}@x`, share_minor: 1, public_token: id, status }); return id; };
    const sent = mk('sent'), paid = mk('paid');
    const snapshot = localDb.group_payments.get(sent)!;
    await groupsRepo.markPaymentViewed(sent);
    await groupsRepo.markPaymentViewed(paid);
    expect(localDb.group_payments.get(sent)!.status).toBe('viewed');
    expect(localDb.group_payments.get(sent)!.viewed_at).toBeTruthy();
    expect(snapshot.status).toBe('sent');
    expect(localDb.group_payments.get(paid)!.status).toBe('paid');
  });
  it('second mood check-in in the same ISO week keeps the original id', async () => {
    const uid = crypto.randomUUID();
    const a = await vaultRepo.saveMoodCheckin(uid, 'okay');
    const b = await vaultRepo.saveMoodCheckin(uid, 'great');
    expect(b.id).toBe(a.id);
    expect(b.level).toBe('great');
  });
});

describe('A6 currency allowlist (local driver + schemas)', () => {
  it('shared constant is exactly the SQL allowlist', () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY', 'KRW', 'KWD']);
  });
  it('local profile upsert rejects unsupported currency like chk_profiles_currency', async () => {
    const base = { id: crypto.randomUUID(), name: 'C', timezone: 'UTC', max_distance_km: 5, guilt_free_cap_minor: 0, per_action_cap_minor: 0, weekly_cap_minor: 0, opt_in_mood: false, opt_in_tracking: false, exploration_level: 'normal' as const };
    await expect(profilesRepo.upsert({ ...base, currency: 'XYZ' as any })).rejects.toThrow(/Unsupported currency/);
  });
  it('PATCH /api/me/settings rejects a non-allowlisted 3-letter currency with 400', async () => {
    const r = await api('/api/me/settings', crypto.randomUUID(), { method: 'PATCH', body: JSON.stringify({ currency: 'XYZ' }) });
    expect(r.status).toBe(400);
  });
});

describe('D5 toMinorUnits strictness / fun money cap 0', () => {
  it('rejects excess fractional digits, junk and unknown currencies; never NaN or silent truncation', () => {
    expect(moneyService.toMinorUnits('19.99', 'USD')).toBe(1999);
    expect(moneyService.toMinorUnits('10.50', 'USD')).toBe(1050);
    expect(moneyService.toMinorUnits('10.500', 'USD')).toBe(1050);
    expect(moneyService.toMinorUnits('1,234.5', 'USD')).toBe(123450);
    expect(moneyService.toMinorUnits('1.234', 'KWD')).toBe(1234);
    expect(moneyService.toMinorUnits('100', 'JPY')).toBe(100);
    expect(() => moneyService.toMinorUnits('10.999', 'USD')).toThrow(/fractional/);
    expect(() => moneyService.toMinorUnits('10.5', 'JPY')).toThrow(/fractional/);
    expect(() => moneyService.toMinorUnits('abc', 'USD')).toThrow();
    expect(() => moneyService.toMinorUnits('', 'USD')).toThrow();
    expect(() => moneyService.toMinorUnits('1e3', 'USD')).toThrow();
    expect(() => moneyService.toMinorUnits(NaN, 'USD')).toThrow();
    expect(() => moneyService.toMinorUnits('10', 'XYZ')).toThrow(/Unsupported currency/);
  });
  it('guilt-free cap 0 yields 0 available (not uncapped)', () => {
    expect(moneyService.computeFunMoney(100000, 0, 0, 0, 0)).toBe(0);
    expect(moneyService.computeFunMoney(100000, 0, 0, 0, 5000)).toBe(5000);
  });
});
