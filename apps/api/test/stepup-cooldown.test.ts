import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'http';
import { SignJWT } from 'jose';
import app from '../src/index.js';
import { config } from '../src/core/config.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { base32Decode, hotp, totpStep } from '../src/services/totp.js';
import { SoftwareAuthenticator } from './helpers/authenticator.js';
import { TEST_PIN } from './helpers/stepup.js';

interface R<T> { ok: boolean; data: T; error?: { code: string; message: string; details?: { remainingSeconds?: number } } }

describe('H1: step-up enrollment cooldown, fresh-session gate, audit trail and notifications', () => {
  let server: Server;
  let baseUrl: string;
  const userId = '00000000-0000-4000-a000-000000000001';
  let token: string;
  let seq = 0;
  const key = () => `h1_${Date.now()}_${++seq}_${crypto.randomBytes(4).toString('hex')}`;

  const call = async <T>(method: string, path: string, body?: unknown, tok = token, extra: Record<string, string> = {}) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, json: (await res.json()) as R<T> };
  };
  const staleToken = async (ageSeconds: number) =>
    new SignJWT({ sub: userId, email: 'aarav@pocketful.demo', user_metadata: { name: 'Aarav' }, role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - ageSeconds)
      .setExpirationTime('24h')
      .setAudience('authenticated')
      .sign(new TextEncoder().encode(config.SUPABASE_JWT_SECRET));

  const stage = async (amountMinor = 500) =>
    (await call<{ approval: { id: string } }>('POST', '/api/vault/decide', { action: 'roll_over', amountMinor })).json.data.approval.id;
  const pinProof = (pin = TEST_PIN) => ({ method: 'pin' as const, pin });
  const ageCooldown = (hours: number) => {
    const c = localDb.step_up.get(userId)!;
    c.factor_changed_at = new Date(Date.now() - hours * 3_600_000).toISOString();
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
  beforeEach(() => {
    initLocalSeed();
    for (const m of [localDb.approvals, localDb.step_up, localDb.webauthn_credentials, localDb.webauthn_challenges]) m.clear();
    localDb.audit_log.length = 0;
    localDb.security_notifications.length = 0;
    config.STEPUP_ENROLL_COOLDOWN_HOURS = 24;
  });
  afterEach(() => { config.STEPUP_ENROLL_COOLDOWN_HOURS = 0; config.STEP_UP_TEST_MODE = false; });

  // ---------------------------------------------------------------------------------------------
  describe('cooldown after a factor is enrolled, replaced or reset', () => {
    it('a freshly enrolled PIN cannot get a challenge or approve money: 403 STEP_UP_COOLDOWN + remainingSeconds', async () => {
      expect((await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN })).status).toBe(200);
      const id = await stage();

      const ch = await call('POST', `/api/approvals/${id}/challenge`);
      expect(ch.status).toBe(403);
      expect(ch.json.error?.code).toBe('STEP_UP_COOLDOWN');
      const remaining = ch.json.error?.details?.remainingSeconds ?? 0;
      expect(remaining).toBeGreaterThan(24 * 3600 - 30);
      expect(remaining).toBeLessThanOrEqual(24 * 3600);

      // Even a hand-built decide request (nonce planted directly) is refused at the gate.
      const d = await call('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: pinProof(), challengeNonce: 'x'.repeat(48) }, token, { 'Idempotency-Key': key() });
      expect(d.status).toBe(403);
      expect(d.json.error?.code).toBe('STEP_UP_COOLDOWN');
      expect(typeof d.json.error?.details?.remainingSeconds).toBe('number');
    });

    it('the same flow works once the cooldown has elapsed', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      ageCooldown(24.5);
      const id = await stage();
      const ch = await call<{ challengeNonce: string }>('POST', `/api/approvals/${id}/challenge`);
      expect(ch.status).toBe(200);
      const d = await call('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: pinProof(), challengeNonce: ch.json.data.challengeNonce }, token, { 'Idempotency-Key': key() });
      expect(d.status).toBe(200);
    });

    it('denying is never blocked by the cooldown (only money-approving is)', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const id = await stage();
      const d = await call('POST', `/api/approvals/${id}/decide`, { decision: 'deny' }, token, { 'Idempotency-Key': key() });
      expect(d.status).toBe(200);
    });

    it('with STEPUP_ENROLL_COOLDOWN_HOURS=0 nothing is blocked', async () => {
      config.STEPUP_ENROLL_COOLDOWN_HOURS = 0;
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const id = await stage();
      expect((await call('POST', `/api/approvals/${id}/challenge`)).status).toBe(200);
    });

    it('replacing the PIN restarts the cooldown', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      ageCooldown(30);
      const ok = await call('PUT', '/api/auth/step-up/pin', { pin: '739518', proof: pinProof() });
      expect(ok.status).toBe(200);
      const id = await stage();
      const ch = await call('POST', `/api/approvals/${id}/challenge`);
      expect(ch.status).toBe(403);
      expect(ch.json.error?.code).toBe('STEP_UP_COOLDOWN');
    });

    it('confirming a TOTP authenticator restarts the cooldown; merely starting setup does not', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      ageCooldown(30);
      const begin = await call<{ secret: string }>('POST', '/api/auth/step-up/totp/enroll', { proof: pinProof() });
      expect(begin.status).toBe(200);
      // pending secret only: money actions still work
      const id1 = await stage(501);
      expect((await call('POST', `/api/approvals/${id1}/challenge`)).status).toBe(200);

      const code = hotp(base32Decode(begin.json.data.secret), totpStep(Date.now()));
      expect((await call('POST', '/api/auth/step-up/totp/confirm', { code })).status).toBe(200);
      const id2 = await stage(502);
      const ch = await call('POST', `/api/approvals/${id2}/challenge`);
      expect(ch.status).toBe(403);
      expect(ch.json.error?.code).toBe('STEP_UP_COOLDOWN');
    });

    it('registering a passkey restarts the cooldown', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      ageCooldown(30);
      const auth = new SoftwareAuthenticator(config.WEBAUTHN_RP_ID, config.WEBAUTHN_ORIGINS[0]!);
      const o = await call<{ options: { challenge: string } }>('POST', '/api/auth/passkeys/register/options', { proof: pinProof() });
      expect(o.status).toBe(200);
      const v = await call('POST', '/api/auth/passkeys/register/verify', { attestation: auth.register(o.json.data.options as never), label: 'k' });
      expect(v.status).toBe(200);
      const id = await stage();
      const ch = await call('POST', `/api/approvals/${id}/challenge`);
      expect(ch.status).toBe(403);
      expect(ch.json.error?.code).toBe('STEP_UP_COOLDOWN');
    });

    it('the status endpoint tells the client how long is left', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const s = await call<{ cooldownRemainingSeconds: number }>('GET', '/api/auth/step-up');
      expect(s.json.data.cooldownRemainingSeconds).toBeGreaterThan(24 * 3600 - 30);
      ageCooldown(25);
      expect((await call<{ cooldownRemainingSeconds: number }>('GET', '/api/auth/step-up')).json.data.cooldownRemainingSeconds).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('first enrollment requires a fresh session (iat within 5 minutes)', () => {
    it('a 10-minute-old token cannot enroll the first PIN', async () => {
      const old = await staleToken(600);
      const r = await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN }, old);
      expect([401, 403]).toContain(r.status);
      expect(r.json.error?.code).toBe('FRESH_SESSION_REQUIRED');
      expect(localDb.step_up.get(userId)?.pin_hash ?? null).toBeNull();
    });

    it('same for TOTP setup and passkey registration', async () => {
      const old = await staleToken(600);
      const t = await call('POST', '/api/auth/step-up/totp/enroll', {}, old);
      const p = await call('POST', '/api/auth/passkeys/register/options', {}, old);
      for (const r of [t, p]) {
        expect([401, 403]).toContain(r.status);
        expect(r.json.error?.code).toBe('FRESH_SESSION_REQUIRED');
      }
    });

    it('a token issued 4 minutes ago is fresh enough', async () => {
      const r = await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN }, await staleToken(240));
      expect(r.status).toBe(200);
    });

    it('a stale session CAN change factors when it proves an existing one (freshness is for first enrollment only)', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const r = await call('PUT', '/api/auth/step-up/pin', { pin: '739518', proof: pinProof() }, await staleToken(3600));
      expect(r.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('audit log + user-visible notification', () => {
    const security = () => localDb.audit_log.filter((l) => l.agent === 'step_up');

    it('enrolling, replacing and removing each write an audit row and a notification', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      await call('PUT', '/api/auth/step-up/pin', { pin: '739518', proof: pinProof() });
      const begin = await call<{ secret: string }>('POST', '/api/auth/step-up/totp/enroll', { proof: pinProof('739518') });
      await call('POST', '/api/auth/step-up/totp/confirm', { code: hotp(base32Decode(begin.json.data.secret), totpStep(Date.now())) });
      const rm = await call('DELETE', '/api/auth/step-up/pin', { proof: pinProof('739518') });
      expect(rm.status).toBe(200);

      expect(security().map((l) => l.action)).toEqual(['factor_enrolled', 'factor_replaced', 'factor_enrolled', 'factor_removed']);
      expect(security().every((l) => l.user_id === userId)).toBe(true);
      expect(security().map((l) => (l.params as { factor: string }).factor)).toEqual(['pin', 'pin', 'totp', 'pin']);

      const n = await call<{ notifications: Array<{ kind: string; factor: string; message: string; created_at: string }> }>('GET', '/api/auth/security-notifications');
      expect(n.status).toBe(200);
      expect(n.json.data.notifications.map((x) => `${x.kind}:${x.factor}`).sort()).toEqual(
        ['factor_enrolled:pin', 'factor_enrolled:totp', 'factor_removed:pin', 'factor_replaced:pin'].sort()
      );
      expect(n.json.data.notifications.every((x) => x.message.length > 10 && !!x.created_at)).toBe(true);
    });

    it('notifications and audit rows never contain PINs, secrets or codes', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const begin = await call<{ secret: string }>('POST', '/api/auth/step-up/totp/enroll', { proof: pinProof() });
      await call('POST', '/api/auth/step-up/totp/confirm', { code: hotp(base32Decode(begin.json.data.secret), totpStep(Date.now())) });
      const blob = JSON.stringify([localDb.audit_log, localDb.security_notifications]);
      expect(blob).not.toContain(TEST_PIN);
      expect(blob).not.toContain(begin.json.data.secret);
    });

    it("one user cannot read another user's notifications", async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const other = await createDevToken('00000000-0000-4000-a000-0000000000f1', 'other@pocketful.demo', 'Other');
      const n = await call<{ notifications: unknown[] }>('GET', '/api/auth/security-notifications', undefined, other);
      expect(n.status).toBe(200);
      expect(n.json.data.notifications).toEqual([]);
    });

    it('requires authentication', async () => {
      const r = await fetch(`${baseUrl}/api/auth/security-notifications`);
      expect(r.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('removing factors', () => {
    it('removal needs proof from an existing factor', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const none = await call('DELETE', '/api/auth/step-up/pin', {});
      expect(none.status).toBe(403);
      expect(none.json.error?.code).toBe('STEP_UP_REQUIRED');
      const wrong = await call('DELETE', '/api/auth/step-up/pin', { proof: pinProof('135792') });
      expect(wrong.status).toBe(403);
      expect(localDb.step_up.get(userId)?.pin_hash).toBeTruthy();
    });

    it('removing the LAST factor requires proof, then leaves the user unenrolled', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const r = await call('DELETE', '/api/auth/step-up/pin', { proof: pinProof() });
      expect(r.status).toBe(200);
      const s = await call<{ enrolled: boolean; methods: string[] }>('GET', '/api/auth/step-up');
      expect(s.json.data.enrolled).toBe(false);
      expect(s.json.data.methods).toEqual([]);
    });

    it('re-enrolling after removing the last factor starts a fresh cooldown, even if the old one had expired', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      ageCooldown(48);
      await call('DELETE', '/api/auth/step-up/pin', { proof: pinProof() });
      expect((await call('PUT', '/api/auth/step-up/pin', { pin: '739518' })).status).toBe(200);
      const id = await stage();
      const ch = await call('POST', `/api/approvals/${id}/challenge`);
      expect(ch.status).toBe(403);
      expect(ch.json.error?.code).toBe('STEP_UP_COOLDOWN');
    });

    it('removing the last factor also needs a fresh-session re-enroll (stale token cannot quietly come back)', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      await call('DELETE', '/api/auth/step-up/pin', { proof: pinProof() });
      const r = await call('PUT', '/api/auth/step-up/pin', { pin: '739518' }, await staleToken(900));
      expect(r.json.error?.code).toBe('FRESH_SESSION_REQUIRED');
    });

    it('removing a passkey needs proof and deletes only the caller\'s own credential', async () => {
      config.STEPUP_ENROLL_COOLDOWN_HOURS = 0;
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const auth = new SoftwareAuthenticator(config.WEBAUTHN_RP_ID, config.WEBAUTHN_ORIGINS[0]!);
      const o = await call<{ options: { challenge: string } }>('POST', '/api/auth/passkeys/register/options', { proof: pinProof() });
      await call('POST', '/api/auth/passkeys/register/verify', { attestation: auth.register(o.json.data.options as never), label: 'k' });
      const list = await call<{ passkeys: Array<{ id: string }> }>('GET', '/api/auth/passkeys');
      const pid = list.json.data.passkeys[0]!.id;

      expect((await call('DELETE', `/api/auth/passkeys/${pid}`, {})).status).toBe(403);
      const other = await createDevToken('00000000-0000-4000-a000-0000000000f2', 'o2@pocketful.demo', 'O2');
      expect((await call('DELETE', `/api/auth/passkeys/${pid}`, { proof: pinProof() }, other)).status).toBeGreaterThanOrEqual(400);
      expect(localDb.webauthn_credentials.size).toBe(1);

      expect((await call('DELETE', `/api/auth/passkeys/${pid}`, { proof: pinProof() })).status).toBe(200);
      expect(localDb.webauthn_credentials.size).toBe(0);
    });

    it('deleting a factor that is not set is a clean 404, not a state change', async () => {
      await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN });
      const r = await call('DELETE', '/api/auth/step-up/totp', { proof: pinProof() });
      expect(r.status).toBe(404);
    });
  });
});
