import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { moneyService } from '../src/services/money.js';
import { enrollTestPin, stepUp } from './helpers/stepup.js';

const userId = '00000000-0000-4000-a000-000000000001';

describe('Currency change goes through the Guardian and preserves caps (B5)', () => {
  let server: Server; let baseUrl: string; let token: string;
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const profile = () => localDb.profiles.get(userId)!;

  beforeAll(async () => {
    initLocalSeed();
    token = await createDevToken(userId, 'aarav@pocketful.demo', 'Aarav Sharma');
    await new Promise<void>((resolve) => { server = app.listen(0, () => { const a = server.address(); if (a && typeof a === 'object') baseUrl = `http://localhost:${a.port}`; resolve(); }); });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(async () => {
    initLocalSeed(); localDb.approvals.clear(); localDb.step_up.clear();
    localDb.profiles.set(userId, { ...profile(), currency: 'USD', per_action_cap_minor: 25000, weekly_cap_minor: 50000, guilt_free_cap_minor: 15000 });
    for (const [id, g] of localDb.groups) if (g.organizer_id === userId) localDb.groups.delete(id);
    await enrollTestPin(baseUrl, token);
  });

  it('convertMinorPreservingMajor keeps the major number across exponents', () => {
    expect(moneyService.convertMinorPreservingMajor(25000, 'USD', 'JPY')).toBe(250);
    expect(moneyService.convertMinorPreservingMajor(250, 'JPY', 'USD')).toBe(25000);
    expect(moneyService.convertMinorPreservingMajor(25000, 'USD', 'KWD')).toBe(250000);
    expect(moneyService.convertMinorPreservingMajor(250000, 'KWD', 'INR')).toBe(25000);
  });

  it('does NOT change currency directly; it stages an approval and caps are untouched', async () => {
    const r = await call('PATCH', '/api/me/settings', { currency: 'JPY' });
    expect(r.status).toBe(200);
    expect(r.json.data.requiresApproval).toBe(true);
    expect(profile().currency).toBe('USD');
    expect(profile().weekly_cap_minor).toBe(50000);
  });

  it('executes after step-up and converts all caps preserving the major-unit amount', async () => {
    const r = await call('PATCH', '/api/me/settings', { currency: 'JPY' });
    const id = r.json.data.approval.id;
    const c = await call('POST', `/api/approvals/${id}/challenge`);
    const d = await call('POST', `/api/approvals/${id}/decide`, { decision: 'approve', ...stepUp(c.json.data) }, { 'Idempotency-Key': `k_${crypto.randomUUID()}` });
    expect(d.status).toBe(200);
    expect(profile()).toMatchObject({ currency: 'JPY', per_action_cap_minor: 250, weekly_cap_minor: 500, guilt_free_cap_minor: 150 });
  });

  it('rejects unsupported currencies and mixing currency with other settings', async () => {
    expect((await call('PATCH', '/api/me/settings', { currency: 'XXX' })).status).toBe(400);
    expect((await call('PATCH', '/api/me/settings', { currency: 'EUR', weeklyCapMinor: 1 })).status).toBe(400);
    expect(profile().currency).toBe('USD');
  });

  it('is blocked while group outings or approvals are open, or after spending this week', async () => {
    localDb.approvals.set('a1', { id: 'a1', user_id: userId, action_type: 'vault_move', payload: {}, preview: 'x', amount_minor: 1, money_out_minor: 1, status: 'pending', idempotency_key: 'k1', retry_count: 0, expires_at: new Date(Date.now() + 60000).toISOString() } as never);
    expect((await call('PATCH', '/api/me/settings', { currency: 'EUR' })).status).toBe(409);
    localDb.approvals.clear();
    localDb.approvals.set('a2', { id: 'a2', user_id: userId, action_type: 'vault_move', payload: {}, preview: 'x', amount_minor: 100, money_out_minor: 100, status: 'executed', idempotency_key: 'k2', retry_count: 0, decided_at: new Date().toISOString(), executed_at: new Date().toISOString(), expires_at: new Date().toISOString() } as never);
    expect((await call('PATCH', '/api/me/settings', { currency: 'EUR' })).status).toBe(409);
  });

  it('a currency approval staged earlier cannot be executed after the currency already changed', async () => {
    const r = await call('PATCH', '/api/me/settings', { currency: 'JPY' });
    const id = r.json.data.approval.id;
    localDb.profiles.set(userId, { ...profile(), currency: 'EUR' });
    const c = await call('POST', `/api/approvals/${id}/challenge`);
    const d = await call('POST', `/api/approvals/${id}/decide`, { decision: 'approve', ...stepUp(c.json.data) }, { 'Idempotency-Key': `k_${crypto.randomUUID()}` });
    expect(d.status).not.toBe(200);
    expect(profile().currency).toBe('EUR');
  });
});
