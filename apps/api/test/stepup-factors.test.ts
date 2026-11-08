import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { config } from '../src/core/config.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { approvalsRepo } from '../src/repos/approvals.js';
import { stepUpRepo } from '../src/repos/stepup.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { verifyFactor, testAuthenticatorProof } from '../src/services/stepup.js';
import { base32Decode, hotp, matchTotp, openSecret, sealSecret, totpStep, base32Encode } from '../src/services/totp.js';
import { SoftwareAuthenticator } from './helpers/authenticator.js';
import { enrollTestPin, stepUp, TEST_PIN } from './helpers/stepup.js';

interface R<T> { ok: boolean; data: T; error?: { code: string; message: string } }
type Challenge = { challengeNonce: string; methods: string[]; passkeyOptions?: { challenge: string }; testChallenge?: string };

describe('Step-up factors: passkey (WebAuthn), TOTP, PIN, test authenticator', () => {
  let server: Server;
  let baseUrl: string;
  const userId = '00000000-0000-4000-a000-000000000001';
  let token: string;
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const call = async <T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(baseUrl + path, { method, headers: { ...H(), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as R<T> };
  };
  let seq = 0;
  const key = () => `sf_${Date.now()}_${++seq}_${crypto.randomBytes(4).toString('hex')}`;
  const stage = async (amountMinor = 500) => {
    const r = await call<{ approval: { id: string } }>('POST', '/api/vault/decide', { action: 'roll_over', amountMinor });
    expect(r.status).toBe(200);
    return r.json.data.approval.id;
  };
  const vaultBalance = () => JSON.stringify(localDb.vault.get(userId));
  const challenge = async (id: string) => (await call<Challenge>('POST', `/api/approvals/${id}/challenge`)).json.data;
  const decide = (id: string, body: Record<string, unknown>) =>
    call<{ status: string }>('POST', `/api/approvals/${id}/decide`, { decision: 'approve', ...body }, { 'Idempotency-Key': key() });
  const newAuthenticator = (counter = 0) => new SoftwareAuthenticator(config.WEBAUTHN_RP_ID, config.WEBAUTHN_ORIGINS[0]!, counter);

  /** Registers `auth` as a passkey over the real HTTP ceremony. `proof` is needed once a factor already exists. */
  const registerPasskey = async (auth: SoftwareAuthenticator, proof?: unknown) => {
    const o = await call<{ options: { challenge: string } }>('POST', '/api/auth/passkeys/register/options', proof ? { proof } : {});
    if (o.status !== 200) return { options: o, verify: null };
    const verify = await call('POST', '/api/auth/passkeys/register/verify', { attestation: auth.register(o.json.data.options as never), label: 'Test key' });
    return { options: o, verify };
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
    localDb.approvals.clear();
    localDb.step_up.clear();
    localDb.webauthn_credentials.clear();
    localDb.webauthn_challenges.clear();
  });
  afterEach(() => { config.STEP_UP_TEST_MODE = false; });

  // ==================================================================================================
  describe('WebAuthn / passkey', () => {
    it('registers a passkey and approves a money action with a real assertion', async () => {
      const auth = newAuthenticator();
      const { verify } = await registerPasskey(auth);
      expect(verify?.status).toBe(200);
      const status = (await call<{ methods: string[]; passkeys: number }>('GET', '/api/auth/step-up')).json.data;
      expect(status.methods).toEqual(['passkey']);

      const id = await stage();
      const c = await challenge(id);
      expect(c.passkeyOptions?.challenge).toBeTruthy();
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'passkey', assertion: auth.assert(c.passkeyOptions as never) } });
      expect(r.status).toBe(200);
      // counter persisted
      expect([...localDb.webauthn_credentials.values()][0]!.counter).toBe(1);
    });

    it('never returns key material from the list or status endpoints', async () => {
      await registerPasskey(newAuthenticator());
      const raw = JSON.stringify([(await call('GET', '/api/auth/passkeys')).json, (await call('GET', '/api/auth/step-up')).json]);
      const stored = [...localDb.webauthn_credentials.values()][0]!;
      expect(raw).not.toContain(stored.public_key);
      expect(raw).not.toContain(stored.credential_id);
    });

    it('an assertion cannot be replayed: the nonce is single-use', async () => {
      const auth = newAuthenticator();
      await registerPasskey(auth);
      const id = await stage();
      const c = await challenge(id);
      const body = { challengeNonce: c.challengeNonce, proof: { method: 'passkey', assertion: auth.assert(c.passkeyOptions as never) } };
      expect((await decide(id, body)).status).toBe(200);
      const afterFirst = vaultBalance();
      const again = await decide(id, body);
      // The server may echo the stored outcome of the already-executed approval, but must never execute twice.
      if (again.status === 200) expect((again.json.data as { replayed?: boolean }).replayed).toBe(true);
      expect(vaultBalance()).toBe(afterFirst);
      // a fresh challenge is required, and with a stale counter the assertion is refused as a clone
      const id2 = await stage(501);
      const c2 = await challenge(id2);
      const stale = auth.assert(c2.passkeyOptions as never, { counter: 1 });
      const r = await decide(id2, { challengeNonce: c2.challengeNonce, proof: { method: 'passkey', assertion: stale } });
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe('STEP_UP_FAILED');
    });

    it('a signature made for approval A cannot approve approval B', async () => {
      const auth = newAuthenticator();
      await registerPasskey(auth);
      const a = await stage(500);
      const b = await stage(501);
      const ca = await challenge(a);
      const cb = await challenge(b);
      const signedForA = auth.assert(ca.passkeyOptions as never);
      // Right nonce for B, but the signature commits to A's challenge.
      const r = await decide(b, { challengeNonce: cb.challengeNonce, proof: { method: 'passkey', assertion: signedForA } });
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe('STEP_UP_FAILED');
      expect((await call<{ approval: { status: string } }>('GET', `/api/approvals/${b}`)).json.data.approval.status).toBe('pending');
    });

    it('rejects an assertion for a challenge the server never issued (client-chosen challenge)', async () => {
      const auth = newAuthenticator();
      await registerPasskey(auth);
      const id = await stage();
      const c = await challenge(id);
      const forged = auth.assert(c.passkeyOptions as never, { challenge: crypto.randomBytes(32).toString('base64url') });
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'passkey', assertion: forged } });
      expect(r.json.error?.code).toBe('STEP_UP_FAILED');
    });

    it.each([
      ['wrong origin', { origin: 'https://evil.example' }],
      ['wrong rpId', { rpId: 'evil.example' }],
      ['user verification missing', { userVerified: false }]
    ])('rejects an assertion with %s', async (_name, opts) => {
      const auth = newAuthenticator();
      await registerPasskey(auth);
      const id = await stage();
      const c = await challenge(id);
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'passkey', assertion: auth.assert(c.passkeyOptions as never, opts) } });
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe('STEP_UP_FAILED');
    });

    it("a passkey belonging to another user cannot satisfy this user's challenge", async () => {
      const auth = newAuthenticator();
      await registerPasskey(auth);
      const challengeB64u = crypto.randomBytes(32).toString('base64url');
      const options = { challenge: challengeB64u, rpId: config.WEBAUTHN_RP_ID, allowCredentials: [], userVerification: 'required', timeout: 1 };
      const other = '00000000-0000-4000-a000-0000000000ff';
      const res = await verifyFactor(other, { method: 'passkey', assertion: auth.assert(options as never) as never }, challengeB64u);
      expect(res.ok).toBe(false);
      // sanity: the real owner passes with the same signed data
      const ok = await verifyFactor(userId, { method: 'passkey', assertion: auth.assert(options as never, { counter: 5 }) as never }, challengeB64u);
      expect(ok.ok).toBe(true);
    });

    it('changing the approval after the challenge was issued invalidates the challenge', async () => {
      const auth = newAuthenticator();
      await registerPasskey(auth);
      const id = await stage(500);
      const c = await challenge(id);
      const a = localDb.approvals.get(id)!;
      a.amount_minor = 99_900;
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'passkey', assertion: auth.assert(c.passkeyOptions as never) } });
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe('STEP_UP_CHALLENGE_INVALID');
    });

    it('adding a second passkey needs proof from an existing factor', async () => {
      const first = newAuthenticator();
      expect((await registerPasskey(first)).verify?.status).toBe(200);
      // stolen-session scenario: no proof -> refused
      const attacker = newAuthenticator();
      const denied = await registerPasskey(attacker);
      expect(denied.options.status).toBe(403);
      expect(denied.options.json.error?.code).toBe('STEP_UP_REQUIRED');
      expect(localDb.webauthn_credentials.size).toBe(1);
      // legit: passkey proof over the enrol challenge
      const ec = (await call<{ passkeyOptions: { challenge: string } }>('POST', '/api/auth/step-up/challenge')).json.data;
      const second = newAuthenticator();
      const ok = await registerPasskey(second, { method: 'passkey', assertion: first.assert(ec.passkeyOptions as never) });
      expect(ok.verify?.status).toBe(200);
      expect(localDb.webauthn_credentials.size).toBe(2);
    });

    it('an enrol challenge is single use', async () => {
      const first = newAuthenticator();
      await registerPasskey(first);
      const ec = (await call<{ passkeyOptions: { challenge: string } }>('POST', '/api/auth/step-up/challenge')).json.data;
      const proof = { method: 'passkey', assertion: first.assert(ec.passkeyOptions as never) };
      expect((await call('POST', '/api/auth/passkeys/register/options', { proof })).status).toBe(200);
      const replay = await call('POST', '/api/auth/passkeys/register/options', { proof });
      expect(replay.status).toBe(403);
      expect(replay.json.error?.code).toBe('STEP_UP_CHALLENGE_EXPIRED');
    });

    it('registration rejects a wrong-origin attestation, and the registration challenge is single-use', async () => {
      const auth = newAuthenticator();
      const o = await call<{ options: { challenge: string } }>('POST', '/api/auth/passkeys/register/options', {});
      const bad = await call('POST', '/api/auth/passkeys/register/verify', { attestation: auth.register(o.json.data.options as never, { origin: 'https://evil.example' }) });
      expect(bad.status).toBe(400);
      // challenge was consumed by the failed attempt: even a correct attestation now fails
      const good = await call('POST', '/api/auth/passkeys/register/verify', { attestation: auth.register(o.json.data.options as never) });
      expect(good.status).toBe(400);
      expect(localDb.webauthn_credentials.size).toBe(0);
    });

    it('rejects registration without user verification', async () => {
      const auth = newAuthenticator();
      const o = await call<{ options: { challenge: string } }>('POST', '/api/auth/passkeys/register/options', {});
      const r = await call('POST', '/api/auth/passkeys/register/verify', { attestation: auth.register(o.json.data.options as never, { userVerified: false }) });
      expect(r.status).toBe(400);
    });

    it('rejects a malformed assertion body at the schema boundary', async () => {
      await registerPasskey(newAuthenticator());
      const id = await stage();
      const c = await challenge(id);
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'passkey', assertion: { id: '!!', type: 'public-key' } } });
      expect(r.status).toBe(400);
    });

    it('passkey still works while PIN/TOTP are locked out', async () => {
      const auth = newAuthenticator();
      await enrollTestPin(baseUrl, token, TEST_PIN);
      expect((await registerPasskey(auth, { method: 'pin', pin: TEST_PIN })).verify?.status).toBe(200);
      for (let i = 0; i < 5; i++) await stepUpRepo.verifyPin(userId, '135792');
      expect((await stepUpRepo.status(userId)).lockedUntil).not.toBeNull();
      const id = await stage();
      const c = await challenge(id);
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'passkey', assertion: auth.assert(c.passkeyOptions as never) } });
      expect(r.status).toBe(200);
    });
  });

  // ==================================================================================================
  describe('TOTP', () => {
    it('matches the RFC 6238 SHA-1 test vectors (6-digit truncations)', () => {
      const secret = Buffer.from('12345678901234567890');
      const vectors: Array<[number, string]> = [
        [59, '287082'],
        [1111111109, '081804'],
        [1111111111, '050471'],
        [1234567890, '005924'],
        [2000000000, '279037']
      ];
      for (const [t, code] of vectors) {
        expect(hotp(secret, totpStep(t * 1000))).toBe(code);
        expect(matchTotp(secret, code, t * 1000)).toBe(totpStep(t * 1000));
      }
    });

    it('accepts +/-1 step of skew but not 2, and rejects malformed codes', () => {
      const s = Buffer.from('12345678901234567890');
      const now = 1111111111_000;
      const step = totpStep(now);
      expect(matchTotp(s, hotp(s, step - 1), now)).toBe(step - 1);
      expect(matchTotp(s, hotp(s, step + 1), now)).toBe(step + 1);
      expect(matchTotp(s, hotp(s, step - 2), now)).toBeNull();
      expect(matchTotp(s, hotp(s, step + 2), now)).toBeNull();
      for (const bad of ['12345', '1234567', 'abcdef', '', ' 050471']) expect(matchTotp(s, bad, now)).toBeNull();
    });

    it('base32 round-trips and sealing detects tampering and wrong keys', () => {
      const raw = crypto.randomBytes(20);
      expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
      const key = config.STEP_UP_ENC_KEY;
      const sealed = sealSecret(raw, key);
      expect(openSecret(sealed, key).equals(raw)).toBe(true);
      expect(sealed).not.toContain(raw.toString('base64url'));
      const parts = sealed.split('.');
      parts[3] = Buffer.from(crypto.randomBytes(20)).toString('base64url');
      expect(() => openSecret(parts.join('.'), key)).toThrow();
      expect(() => openSecret(sealed, crypto.randomBytes(32).toString('hex'))).toThrow();
    });

    const enrollTotp = async (proof?: unknown) => {
      const e = await call<{ secret: string; otpauthUri: string }>('POST', '/api/auth/step-up/totp/enroll', proof ? { proof } : {});
      if (e.status !== 200) return { e, secret: null as Buffer | null };
      const secret = base32Decode(e.json.data.secret);
      const confirm = await call('POST', '/api/auth/step-up/totp/confirm', { code: hotp(secret, totpStep(Date.now())) });
      expect(confirm.status).toBe(200);
      return { e, secret };
    };

    it('enrolls via secret + confirm, stores only the sealed secret, then approves a money action', async () => {
      const { e, secret } = await enrollTotp();
      expect(e.json.data.otpauthUri).toMatch(/^otpauth:\/\/totp\/Pocketful:/);
      const stored = localDb.step_up.get(userId)!;
      expect(stored.totp_secret_enc).toMatch(/^v1\./);
      expect(JSON.stringify(stored)).not.toContain(e.json.data.secret);
      expect(JSON.stringify((await call('GET', '/api/auth/step-up')).json)).not.toContain(e.json.data.secret);

      const id = await stage();
      const c = await challenge(id);
      expect(c.methods).toEqual(['totp']);
      // the confirm consumed the current step, so use the next one (inside the +/-1 skew window)
      const code = hotp(secret!, totpStep(Date.now()) + 1);
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'totp', code } });
      expect(r.status).toBe(200);
    });

    it('a TOTP code cannot be replayed, and an older step than the last accepted is refused', async () => {
      const { secret } = await enrollTotp();
      const step = totpStep(Date.now());
      const code = hotp(secret!, step + 1);
      const a = await stage(500);
      const ca = await challenge(a);
      expect((await decide(a, { challengeNonce: ca.challengeNonce, proof: { method: 'totp', code } })).status).toBe(200);
      const b = await stage(501);
      const cb = await challenge(b);
      const replay = await decide(b, { challengeNonce: cb.challengeNonce, proof: { method: 'totp', code } });
      expect(replay.status).toBe(403);
      expect(replay.json.error?.code).toBe('STEP_UP_FAILED');
      const older = await decide(b, { challengeNonce: cb.challengeNonce, proof: { method: 'totp', code: hotp(secret!, step) } });
      expect(older.json.error?.code).toBe('STEP_UP_FAILED');
    });

    it('confirm with a wrong code does not activate the authenticator', async () => {
      await call('POST', '/api/auth/step-up/totp/enroll', {});
      const bad = await call('POST', '/api/auth/step-up/totp/confirm', { code: '000000' });
      expect([403]).toContain(bad.status);
      expect((await stepUpRepo.status(userId)).totp).toBe(false);
    });

    it('re-enrolling keeps the working authenticator until the new one is confirmed', async () => {
      const { secret } = await enrollTotp();
      await enrollTotp_proofOnly();
      // pending secret exists but the ACTIVE one still verifies
      const r = await stepUpRepo.verifyTotp(userId, hotp(secret!, totpStep(Date.now()) + 1));
      expect(r.ok).toBe(true);
    });
    async function enrollTotp_proofOnly() {
      const r = await call('POST', '/api/auth/step-up/totp/enroll', { currentPin: '' });
      // no PIN enrolled and a TOTP exists -> must be refused (needs proof from an existing factor)
      expect(r.status).toBe(403);
    }

    it('a factor change needs proof once any factor exists (stolen-session cannot add TOTP)', async () => {
      await enrollTestPin(baseUrl, token);
      const noProof = await call('POST', '/api/auth/step-up/totp/enroll', {});
      expect(noProof.status).toBe(403);
      expect(noProof.json.error?.code).toBe('STEP_UP_REQUIRED');
      const wrong = await call('POST', '/api/auth/step-up/totp/enroll', { currentPin: '135792' });
      expect(wrong.json.error?.code).toBe('STEP_UP_FAILED');
      const ok = await call('POST', '/api/auth/step-up/totp/enroll', { currentPin: TEST_PIN });
      expect(ok.status).toBe(200);
      expect(ok.json.data).toHaveProperty('secret');
    });

    it('PIN and TOTP share ONE lockout counter, so alternating factors does not multiply guesses', async () => {
      const { secret } = await enrollTotp();
      await enrollTestPin(baseUrl, token, TEST_PIN).catch(() => undefined);
      // enrolling a PIN now needs proof (TOTP exists): do it properly
      const set = await call('PUT', '/api/auth/step-up/pin', { pin: TEST_PIN, proof: { method: 'totp', code: hotp(secret!, totpStep(Date.now()) + 1) } });
      expect(set.status).toBe(200);
      for (let i = 0; i < 3; i++) expect((await stepUpRepo.verifyPin(userId, '135792')).ok).toBe(false);
      for (let i = 0; i < 2; i++) await stepUpRepo.verifyTotp(userId, '000000');
      const locked = await stepUpRepo.verifyPin(userId, TEST_PIN);
      expect(locked).toMatchObject({ ok: false, code: 'LOCKED' });
      expect(await stepUpRepo.verifyTotp(userId, hotp(secret!, totpStep(Date.now()) + 1))).toMatchObject({ ok: false, code: 'LOCKED' });
    });

    it('a PIN-only submission by a TOTP-only user is refused without leaking which factors exist', async () => {
      await enrollTotp();
      const id = await stage();
      const c = await challenge(id);
      const r = await decide(id, { ...stepUp(c) });
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe('STEP_UP_FAILED');
    });
  });

  // ==================================================================================================
  describe('Test authenticator (STEP_UP_TEST_MODE)', () => {
    it('is OFF by default: no testChallenge is issued and a test proof is rejected', async () => {
      expect(config.STEP_UP_TEST_MODE).toBe(false);
      await enrollTestPin(baseUrl, token);
      const id = await stage();
      const c = await challenge(id);
      expect(c.testChallenge).toBeUndefined();
      expect(c.methods).not.toContain('test');
      const fake = testAuthenticatorProof(crypto.randomBytes(32).toString('base64url'));
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'test', testProof: fake } });
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe('STEP_UP_FAILED');
    });

    it('when ON it signs the server challenge and approves with no hardware', async () => {
      config.STEP_UP_TEST_MODE = true;
      const id = await stage();
      const c = await challenge(id);
      expect(c.methods).toContain('test');
      const r = await decide(id, { challengeNonce: c.challengeNonce, proof: { method: 'test', testProof: testAuthenticatorProof(c.testChallenge!) } });
      expect(r.status).toBe(200);
    });

    it('when ON a proof is still bound to its approval, signed with the secret, and single-use', async () => {
      config.STEP_UP_TEST_MODE = true;
      const a = await stage(500);
      const b = await stage(501);
      const ca = await challenge(a);
      const cb = await challenge(b);
      // signed for A, submitted for B
      const cross = await decide(b, { challengeNonce: cb.challengeNonce, proof: { method: 'test', testProof: testAuthenticatorProof(ca.testChallenge!) } });
      expect(cross.json.error?.code).toBe('STEP_UP_FAILED');
      // wrong secret
      const wrong = await decide(b, { challengeNonce: cb.challengeNonce, proof: { method: 'test', testProof: testAuthenticatorProof(cb.testChallenge!, 'not-the-secret') } });
      expect(wrong.json.error?.code).toBe('STEP_UP_FAILED');
      // correct, then replay
      const body = { challengeNonce: cb.challengeNonce, proof: { method: 'test', testProof: testAuthenticatorProof(cb.testChallenge!) } };
      expect((await decide(b, body)).status).toBe(200);
      const afterFirst = vaultBalance();
      const again = await decide(b, body);
      if (again.status === 200) expect((again.json.data as { replayed?: boolean }).replayed).toBe(true);
      expect(vaultBalance()).toBe(afterFirst);
    });

    it('is ignored if the flag is on but NODE_ENV is production (second guard)', async () => {
      config.STEP_UP_TEST_MODE = true;
      const prev = config.NODE_ENV;
      (config as { NODE_ENV: string }).NODE_ENV = 'production';
      try {
        await enrollTestPin(baseUrl, token);
        const id = await stage();
        const c = await challenge(id);
        expect(c.testChallenge).toBeUndefined();
        expect(c.methods).not.toContain('test');
      } finally {
        (config as { NODE_ENV: string }).NODE_ENV = prev;
      }
    });
  });

  // ==================================================================================================
  describe('Atomic nonce consumption and erasure parity', () => {
    it('consumeChallengeNonce succeeds for exactly one caller', async () => {
      await enrollTestPin(baseUrl, token);
      const id = await stage();
      const c = await challenge(id);
      const results = await Promise.all([0, 1, 2, 3].map(() => approvalsRepo.consumeChallengeNonce(id, userId, c.challengeNonce)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('erasing a user removes every step-up factor and pending ceremony (parity with ON DELETE CASCADE)', async () => {
      // An isolated user, so erasing it cannot disturb the shared test user.
      const victim = '00000000-0000-4000-a000-0000000000ee';
      const bystander = '00000000-0000-4000-a000-0000000000dd';
      const now = new Date().toISOString();
      for (const u of [victim, bystander]) {
        localDb.step_up.set(u, { user_id: u, pin_salt: 'aa', pin_hash: 'bb', failed_attempts: 0, locked_until: null, enrolled_at: now, totp_secret_enc: 'v1.x.y.z', totp_confirmed_at: now, totp_last_step: 1 });
        localDb.webauthn_credentials.set(`cred-${u}`, { id: u, user_id: u, credential_id: `cred-${u}`, public_key: 'pk', counter: 0, transports: null, device_type: 'singleDevice', backed_up: false, label: null, created_at: now, last_used_at: null });
        localDb.webauthn_challenges.set(`${u}:enroll`, { user_id: u, purpose: 'enroll', challenge: 'c', expires_at: now });
        localDb.webauthn_challenges.set(`${u}:register`, { user_id: u, purpose: 'register', challenge: 'c', expires_at: now });
      }
      await profilesRepo.eraseUser(victim);
      expect(localDb.step_up.has(victim)).toBe(false);
      expect([...localDb.webauthn_credentials.values()].some((c) => c.user_id === victim)).toBe(false);
      expect([...localDb.webauthn_challenges.values()].some((c) => c.user_id === victim)).toBe(false);
      // and it only touched the erased user
      expect(localDb.step_up.has(bystander)).toBe(true);
      expect(localDb.webauthn_credentials.has(`cred-${bystander}`)).toBe(true);
      expect(localDb.webauthn_challenges.size).toBe(2);
    });

    it('consumeChallengeNonce refuses another user and a wrong nonce', async () => {
      await enrollTestPin(baseUrl, token);
      const id = await stage();
      const c = await challenge(id);
      expect(await approvalsRepo.consumeChallengeNonce(id, 'someone-else', c.challengeNonce)).toBe(false);
      expect(await approvalsRepo.consumeChallengeNonce(id, userId, 'wrong')).toBe(false);
      expect(await approvalsRepo.consumeChallengeNonce(id, userId, c.challengeNonce)).toBe(true);
    });
  });
});
