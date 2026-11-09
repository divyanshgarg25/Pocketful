import './env.js';
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { q, asRole, seedProfile, insertApproval } from './helpers.js';

const { stepUpRepo } = await import('../src/repos/stepup.js');
const { webauthnRepo } = await import('../src/repos/webauthn.js');
const { approvalsRepo } = await import('../src/repos/approvals.js');
const { hotp, totpStep, base32Decode } = await import('../src/services/totp.js');
const { isRemoteSupabaseEnabled } = await import('../src/core/database.js');
const { ConflictError } = await import('../src/core/errors.js');

const cred = (userId: string, over: Record<string, unknown> = {}) => ({
  user_id: userId,
  credential_id: randomBytes(24).toString('base64url'),
  public_key: randomBytes(65).toString('base64url'),
  counter: 0,
  transports: ['internal'],
  device_type: 'multiDevice' as const,
  backed_up: true,
  label: 'k',
  ...over
});

describe('step-up factors on real Postgres + PostgREST (B1)', () => {
  it('app is wired to the real DB driver', () => expect(isRemoteSupabaseEnabled).toBe(true));

  describe('step_up_credentials: PIN and TOTP are both optional', () => {
    it('a PIN-only user and a TOTP-only user are both representable, and the secret is stored sealed', async () => {
      const pinUser = await seedProfile();
      await stepUpRepo.setPin(pinUser, '482916');
      expect(await stepUpRepo.status(pinUser)).toMatchObject({ pin: true, totp: false });
      expect((await stepUpRepo.verifyPin(pinUser, '482916')).ok).toBe(true);
      expect((await stepUpRepo.verifyPin(pinUser, '000000')).ok).toBe(false);

      const totpUser = await seedProfile();
      const { secret } = await stepUpRepo.beginTotpEnrollment(totpUser, 'acct');
      // pending only: not yet a usable factor
      expect(await stepUpRepo.status(totpUser)).toMatchObject({ pin: false, totp: false });
      expect((await stepUpRepo.verifyTotp(totpUser, '123456')).ok).toBe(false);
      const ok = await stepUpRepo.confirmTotpEnrollment(totpUser, hotp(base32Decode(secret), totpStep(Date.now())));
      expect(ok.ok).toBe(true);
      expect(await stepUpRepo.status(totpUser)).toMatchObject({ pin: false, totp: true });

      const row = (await q(`select * from step_up_credentials where user_id=$1`, [totpUser])).rows[0];
      expect(row.pin_hash).toBeNull();
      expect(row.totp_secret_enc).toMatch(/^v1\./);
      expect(row.totp_pending_secret_enc).toBeNull();
      expect(JSON.stringify(row)).not.toContain(secret);
    });

    it('CHECK constraints reject half-set PIN and an unconfirmed active TOTP secret', async () => {
      const u = await seedProfile();
      await expect(q(`insert into step_up_credentials(user_id, pin_salt) values ($1,'aa')`, [u])).rejects.toThrow(/chk_step_up_pin_pair/);
      await expect(q(`insert into step_up_credentials(user_id, totp_secret_enc) values ($1,'v1.a.b.c')`, [u])).rejects.toThrow(/chk_step_up_totp_confirmed/);
    });

    it('a TOTP code is accepted exactly once even when 8 requests race with it (real CAS)', async () => {
      const u = await seedProfile();
      const { secret } = await stepUpRepo.beginTotpEnrollment(u, 'acct');
      const raw = base32Decode(secret);
      await stepUpRepo.confirmTotpEnrollment(u, hotp(raw, totpStep(Date.now())));
      const code = hotp(raw, totpStep(Date.now()) + 1);
      const results = await Promise.all(Array.from({ length: 8 }, () => stepUpRepo.verifyTotp(u, code)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await stepUpRepo.verifyTotp(u, code)).ok).toBe(false); // replay after the race
    });

    it('lockout is shared across PIN and TOTP, persists, and does not roll back the TOTP replay counter', async () => {
      const u = await seedProfile();
      await stepUpRepo.setPin(u, '482916');
      const { secret } = await stepUpRepo.beginTotpEnrollment(u, 'acct');
      const raw = base32Decode(secret);
      await stepUpRepo.confirmTotpEnrollment(u, hotp(raw, totpStep(Date.now())));
      const lastStepBefore = (await q(`select totp_last_step from step_up_credentials where user_id=$1`, [u])).rows[0].totp_last_step;

      for (let i = 0; i < 3; i++) await stepUpRepo.verifyPin(u, '135792');
      for (let i = 0; i < 2; i++) await stepUpRepo.verifyTotp(u, '000000');
      const row = (await q(`select failed_attempts, locked_until, totp_last_step from step_up_credentials where user_id=$1`, [u])).rows[0];
      expect(row.locked_until).not.toBeNull();
      // targeted patches: failures never touched the replay counter
      expect(row.totp_last_step).toBe(lastStepBefore);
      expect(await stepUpRepo.verifyPin(u, '482916')).toMatchObject({ ok: false, code: 'LOCKED' });
      expect(await stepUpRepo.verifyTotp(u, hotp(raw, totpStep(Date.now()) + 1))).toMatchObject({ ok: false, code: 'LOCKED' });
    });
  });

  describe('webauthn_credentials / webauthn_challenges', () => {
    it('stores a credential, scopes reads to the owner, and rejects a duplicate credential id', async () => {
      const a = await seedProfile();
      const b = await seedProfile();
      const c = cred(a);
      const created = await webauthnRepo.create(c);
      expect(created.id).toBeTruthy();
      expect((await webauthnRepo.get(a, c.credential_id))?.public_key).toBe(c.public_key);
      expect(await webauthnRepo.get(b, c.credential_id)).toBeNull(); // someone else's credential id is "not found"
      expect(await webauthnRepo.list(b)).toEqual([]);
      await expect(webauthnRepo.create({ ...cred(b), credential_id: c.credential_id })).rejects.toBeInstanceOf(ConflictError);
    });

    it('recordUse is a real compare-and-swap: only one of 6 racers moves the counter', async () => {
      const u = await seedProfile();
      const c = cred(u, { counter: 4 });
      await webauthnRepo.create(c);
      const results = await Promise.all(Array.from({ length: 6 }, () => webauthnRepo.recordUse(u, c.credential_id, 4, 5)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await webauthnRepo.get(u, c.credential_id))?.counter).toBe(5);
      expect(await webauthnRepo.recordUse(u, c.credential_id, 4, 6)).toBe(false); // stale previous counter
      expect((await webauthnRepo.get(u, c.credential_id))?.last_used_at).not.toBeNull();
    });

    it('a ceremony challenge is single-use under concurrency, replaceable, and expires', async () => {
      const u = await seedProfile();
      await webauthnRepo.putChallenge(u, 'register', 'first');
      await webauthnRepo.putChallenge(u, 'register', 'second'); // one live challenge per (user, purpose)
      const got = await Promise.all(Array.from({ length: 6 }, () => webauthnRepo.consumeChallenge(u, 'register')));
      expect(got.filter((x) => x !== null)).toEqual(['second']);
      expect(await webauthnRepo.consumeChallenge(u, 'register')).toBeNull();

      await webauthnRepo.putChallenge(u, 'enroll', 'stale');
      await q(`update webauthn_challenges set expires_at = now() - interval '1 second' where user_id=$1`, [u]);
      expect(await webauthnRepo.consumeChallenge(u, 'enroll')).toBeNull();
      // 'register' and 'enroll' are independent slots
      await webauthnRepo.putChallenge(u, 'register', 'r');
      expect(await webauthnRepo.consumeChallenge(u, 'enroll')).toBeNull();
      expect(await webauthnRepo.consumeChallenge(u, 'register')).toBe('r');
    });
  });

  describe('approval challenge nonce', () => {
    it('consumeChallengeNonce succeeds for exactly one of 8 concurrent callers, and only for the owner', async () => {
      const u = await seedProfile();
      const other = await seedProfile();
      const id = await insertApproval(u, { status: 'pending' });
      const nonce = randomBytes(24).toString('hex');
      await q(`update approvals set challenge_nonce=$2, challenge_expires_at=now()+interval '5 minutes', challenge_fingerprint='fp' where id=$1`, [id, nonce]);
      expect(await approvalsRepo.consumeChallengeNonce(id, other, nonce)).toBe(false);
      expect(await approvalsRepo.consumeChallengeNonce(id, u, 'wrong')).toBe(false);
      const results = await Promise.all(Array.from({ length: 8 }, () => approvalsRepo.consumeChallengeNonce(id, u, nonce)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const row = (await q(`select challenge_nonce, challenge_expires_at, challenge_fingerprint from approvals where id=$1`, [id])).rows[0];
      expect(row).toEqual({ challenge_nonce: null, challenge_expires_at: null, challenge_fingerprint: null });
    });
  });

  describe('privileges and erasure', () => {
    it.each(['webauthn_credentials', 'webauthn_challenges', 'step_up_credentials'])(
      'client roles can neither read nor write %s (service-role only)',
      async (table) => {
        const u = await seedProfile();
        for (const role of ['anon', 'authenticated'] as const) {
          await expect(asRole(role, u, (c) => c.query(`select * from ${table}`))).rejects.toThrow(/permission denied/);
          await expect(asRole(role, u, (c) => c.query(`delete from ${table}`))).rejects.toThrow(/permission denied/);
        }
      }
    );

    it('erase_user removes every factor and ceremony row, and leaves other users untouched', async () => {
      const victim = await seedProfile();
      const bystander = await seedProfile();
      for (const u of [victim, bystander]) {
        await stepUpRepo.setPin(u, '482916');
        await stepUpRepo.beginTotpEnrollment(u, 'a');
        await webauthnRepo.create(cred(u));
        await webauthnRepo.putChallenge(u, 'register', 'x');
        await webauthnRepo.putChallenge(u, 'enroll', 'y');
      }
      expect((await asRole('service_role', null, (c) => c.query('select erase_user($1) as ok', [victim]))).rows[0].ok).toBe(true);
      for (const t of ['step_up_credentials', 'webauthn_credentials', 'webauthn_challenges']) {
        expect((await q(`select count(*)::int n from ${t} where user_id=$1`, [victim])).rows[0].n, t).toBe(0);
        expect((await q(`select count(*)::int n from ${t} where user_id=$1`, [bystander])).rows[0].n, t).toBeGreaterThan(0);
      }
    });
  });
});
