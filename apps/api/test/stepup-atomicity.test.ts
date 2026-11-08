import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { localDb, initLocalSeed } from '../src/core/database.js';
import { config } from '../src/core/config.js';
import { stepUpRepo, MAX_FAILED_ATTEMPTS } from '../src/repos/stepup.js';
import { webauthnRepo } from '../src/repos/webauthn.js';
import { withUserLock } from '../src/core/mutex.js';
import { base32Decode, hotp, totpStep } from '../src/services/totp.js';

const USER = '00000000-0000-4000-a000-0000000000a2';
const PIN = '482916';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('H2: step-up attempt counting is atomic', () => {
  beforeEach(() => {
    initLocalSeed();
    localDb.step_up.clear();
    localDb.webauthn_credentials.clear();
  });

  it('50 concurrent wrong PIN guesses lock at exactly 5 counted attempts', async () => {
    await stepUpRepo.setPin(USER, PIN);
    const results = await Promise.all(Array.from({ length: 50 }, () => stepUpRepo.verifyPin(USER, '135792')));

    const bad = results.filter((r) => !r.ok && r.code === 'BAD_CODE');
    const locked = results.filter((r) => !r.ok && r.code === 'LOCKED');
    // attempts 1..4 are plain failures, the 5th trips the lock; everything after is refused without counting.
    expect(bad).toHaveLength(MAX_FAILED_ATTEMPTS - 1);
    expect(locked).toHaveLength(50 - (MAX_FAILED_ATTEMPTS - 1));
    expect(bad.map((r) => (r as { attemptsLeft: number }).attemptsLeft).sort()).toEqual([1, 2, 3, 4]);
    const st = await stepUpRepo.status(USER);
    expect(st.lockedUntil).not.toBeNull();
  });

  it('a correct PIN submitted after the lock is still refused', async () => {
    await stepUpRepo.setPin(USER, PIN);
    await Promise.all(Array.from({ length: 10 }, () => stepUpRepo.verifyPin(USER, '135792')));
    const r = await stepUpRepo.verifyPin(USER, PIN);
    expect(r).toMatchObject({ ok: false, code: 'LOCKED' });
  });

  it('a correct guess that was in flight when the lock landed does not unlock the account', async () => {
    await stepUpRepo.setPin(USER, PIN);
    // 5 wrong guesses (they will lock) fired together with a correct one: whichever order they finish in, once
    // the lock exists no later success may clear it.
    const all = await Promise.all([
      ...Array.from({ length: 5 }, () => stepUpRepo.verifyPin(USER, '135792')),
      stepUpRepo.verifyPin(USER, PIN)
    ]);
    const lockedAt = (await stepUpRepo.status(USER)).lockedUntil;
    const successes = all.filter((r) => r.ok).length;
    if (successes === 0) expect(lockedAt).not.toBeNull();
    // The correct code can only have won if it landed before the 5th failure; either way a locked account stays locked.
    const after = await stepUpRepo.verifyPin(USER, PIN);
    if (lockedAt) expect(after).toMatchObject({ ok: false, code: 'LOCKED' });
  });

  it('PIN and TOTP share one counter: alternating factors cannot multiply guesses', async () => {
    await stepUpRepo.setPin(USER, PIN);
    const raw = (await stepUpRepo.beginTotpEnrollment(USER, 'x')).secret;
    const key = base32Decode(raw);
    const step = totpStep(Date.now());
    const code = (s: number) => hotp(key, s);
    expect((await stepUpRepo.confirmTotpEnrollment(USER, code(step))).ok).toBe(true);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? stepUpRepo.verifyPin(USER, '135792') : stepUpRepo.verifyTotp(USER, '000000')))
    );
    expect(results.filter((r) => !r.ok && r.code === 'BAD_CODE')).toHaveLength(MAX_FAILED_ATTEMPTS - 1);
  });

  it('withUserLock runs same-user critical sections strictly one at a time, in arrival order', async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string, ms: number) =>
      withUserLock(USER, async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        order.push(`start:${name}`);
        await sleep(ms);
        order.push(`end:${name}`);
        running--;
      });
    await Promise.all([job('a', 20), job('b', 1), job('c', 1)]);
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('withUserLock does not block other users and releases after a throw', async () => {
    const other = '00000000-0000-4000-a000-0000000000b2';
    const log: string[] = [];
    const slow = withUserLock(USER, async () => { await sleep(30); log.push('slow'); });
    const fast = withUserLock(other, async () => { log.push('fast'); });
    await Promise.all([slow, fast]);
    expect(log).toEqual(['fast', 'slow']);
    await expect(withUserLock(USER, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withUserLock(USER, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('H2: TOTP replay defence (atomic compare-and-swap on the last accepted step)', () => {
  beforeEach(() => {
    initLocalSeed();
    localDb.step_up.clear();
  });

  async function enrolled() {
    const raw = (await stepUpRepo.beginTotpEnrollment(USER, 'x')).secret;
    const key = base32Decode(raw);
    const step = totpStep(Date.now());
    const code = (s: number) => hotp(key, s);
    expect((await stepUpRepo.confirmTotpEnrollment(USER, code(step))).ok).toBe(true);
    return { code, step };
  }

  it('the code used to confirm enrollment cannot be replayed to approve something', async () => {
    const { code, step } = await enrolled();
    expect((await stepUpRepo.verifyTotp(USER, code(step))).ok).toBe(false);
  });

  it('two concurrent submissions of the same fresh code: exactly one wins', async () => {
    const { code, step } = await enrolled();
    const next = code(step + 1);
    const rs = await Promise.all(Array.from({ length: 10 }, () => stepUpRepo.verifyTotp(USER, next)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(localDb.step_up.get(USER)!.totp_last_step).toBe(step + 1);
  });

  it('an older step is rejected once a newer one has been accepted', async () => {
    const { code, step } = await enrolled();
    expect((await stepUpRepo.verifyTotp(USER, code(step + 1))).ok).toBe(true);
    expect((await stepUpRepo.verifyTotp(USER, code(step - 1))).ok).toBe(false);
    expect(localDb.step_up.get(USER)!.totp_last_step).toBe(step + 1);
  });
});

describe('H2: passkey signature counter (atomic compare-and-swap)', () => {
  const credId = 'cred-h2-' + crypto.randomBytes(4).toString('hex');
  beforeEach(async () => {
    initLocalSeed();
    localDb.webauthn_credentials.clear();
    await webauthnRepo.create({
      user_id: USER,
      credential_id: credId,
      public_key: 'AAAA',
      counter: 5,
      transports: null,
      device_type: 'multiDevice',
      backed_up: true,
      label: null
    });
  });

  it('concurrent uses from the same stored counter: exactly one succeeds', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => webauthnRepo.recordUse(USER, credId, 5, 6)));
    expect(rs.filter(Boolean)).toHaveLength(1);
    expect((await webauthnRepo.get(USER, credId))!.counter).toBe(6);
  });

  it('refuses to move the counter backwards or sideways (cloned-authenticator signal)', async () => {
    expect(await webauthnRepo.recordUse(USER, credId, 5, 3)).toBe(false);
    expect(await webauthnRepo.recordUse(USER, credId, 5, 5)).toBe(false);
    expect((await webauthnRepo.get(USER, credId))!.counter).toBe(5);
  });

  it('still allows authenticators that always report 0 (no counter support)', async () => {
    localDb.webauthn_credentials.get(credId)!.counter = 0;
    expect(await webauthnRepo.recordUse(USER, credId, 0, 0)).toBe(true);
  });

  it('config exposes the lockout constants the SQL function is called with', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
    expect(config.NODE_ENV).toBe('test');
  });
});
