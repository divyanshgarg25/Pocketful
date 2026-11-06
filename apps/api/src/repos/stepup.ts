import crypto from 'crypto';
import { promisify } from 'util';
import { localDb, supabaseClient, isRemoteSupabaseEnabled, type LocalStepUpCred } from '../core/database.js';
import { config } from '../core/config.js';
import { UpstreamError, ValidationError } from '../core/errors.js';
import { withUserLock } from '../core/mutex.js';
import { matchTotp, openSecret, sealSecret, generateTotpSecret, base32Encode, buildOtpAuthUri } from '../services/totp.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const PIN_REGEX = /^\d{6,12}$/;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

type Cred = LocalStepUpCred;

async function hashPin(pin: string, saltHex: string): Promise<string> {
  return (await scrypt(pin, Buffer.from(saltHex, 'hex'), 64)).toString('hex');
}

export type VerifyResult =
  | { ok: true; /** TOTP confirm only: an authenticator was already set up, so this REPLACED it. */ replaced?: boolean }
  | { ok: false; code: 'NOT_ENROLLED' | 'LOCKED' | 'BAD_CODE'; lockedUntil?: string; attemptsLeft?: number };

export interface FactorStatus {
  pin: boolean;
  totp: boolean;
  lockedUntil: string | null;
  /** Seconds until a newly enrolled/replaced/reset factor may approve money actions again (0 = not in cooldown). */
  cooldownRemainingSeconds: number;
}

/** Result of recording one verification attempt, decided atomically (see registerAttempt). */
type AttemptOutcome = { outcome: 'ok' } | { outcome: 'bad'; attemptsLeft: number } | { outcome: 'locked'; lockedUntil: string };

/**
 * PIN + TOTP storage and verification. Both share ONE failure counter and lockout window (5 failures ->
 * locked 15 minutes) so alternating factors cannot multiply guesses. Secrets/hashes are never returned.
 * Writes are targeted column patches, never whole-row rewrites, so a PIN check can never roll back the TOTP
 * replay counter (and vice versa).
 */
export class StepUpRepo {
  private async get(userId: string): Promise<Cred | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('step_up_credentials').select('*').eq('user_id', userId).maybeSingle();
      if (error) throw new UpstreamError(`[StepUp] read failed: ${error.message}`);
      return (data as Cred) ?? null;
    }
    const c = localDb.step_up.get(userId);
    return c ? { ...c } : null;
  }

  /** Merge `fields` into the row, creating it (PIN and TOTP both optional) if absent. */
  private async patch(userId: string, fields: Partial<Cred>): Promise<void> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient
        .from('step_up_credentials')
        .upsert({ user_id: userId, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw new UpstreamError(`[StepUp] write failed: ${error.message}`);
      return;
    }
    const existing = localDb.step_up.get(userId);
    localDb.step_up.set(userId, {
      user_id: userId,
      pin_salt: null,
      pin_hash: null,
      failed_attempts: 0,
      locked_until: null,
      enrolled_at: new Date().toISOString(),
      totp_secret_enc: null,
      totp_pending_secret_enc: null,
      totp_confirmed_at: null,
      totp_last_step: 0,
      ...existing,
      ...fields
    });
  }

  async status(userId: string): Promise<FactorStatus> {
    const c = await this.get(userId);
    const locked = c?.locked_until && new Date(c.locked_until).getTime() > Date.now() ? c.locked_until : null;
    return { pin: !!c?.pin_hash, totp: !!c?.totp_secret_enc, lockedUntil: locked, cooldownRemainingSeconds: this.cooldownRemaining(c) };
  }

  /**
   * Seconds left in the enrollment cooldown. The anchor (`factor_changed_at`) is stored whenever a factor changes and
   * compared against the CURRENT STEPUP_ENROLL_COOLDOWN_HOURS, so changing the setting applies to existing anchors.
   * Accounts whose factors predate migration 009 have no anchor and are not retroactively blocked.
   */
  private cooldownRemaining(c: Cred | null): number {
    const hours = config.STEPUP_ENROLL_COOLDOWN_HOURS;
    if (!c?.factor_changed_at || !(hours > 0)) return 0;
    const until = new Date(c.factor_changed_at).getTime() + hours * 3_600_000;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  async cooldownRemainingSeconds(userId: string): Promise<number> {
    return this.cooldownRemaining(await this.get(userId));
  }

  /** Starts (or restarts) the enrollment cooldown. Called for every enroll / replace / reset. */
  async markFactorChanged(userId: string): Promise<void> {
    await this.patch(userId, { factor_changed_at: new Date().toISOString() });
  }

  /**
   * Enforces PIN strength and stores the scrypt hash; starts the enrollment cooldown. Authorising the change is the
   * caller's job (see services/stepup). `replaced` is true when a PIN already existed.
   */
  async setPin(userId: string, pin: string): Promise<{ replaced: boolean }> {
    if (!PIN_REGEX.test(pin)) throw new ValidationError('PIN must be 6–12 digits.');
    if (/^(\d)\1+$/.test(pin) || '0123456789012345'.includes(pin) || '9876543210987654'.includes(pin)) {
      throw new ValidationError('PIN is too easy to guess. Avoid repeated or sequential digits.');
    }
    const before = await this.get(userId);
    const salt = crypto.randomBytes(16).toString('hex');
    await this.patch(userId, {
      pin_salt: salt,
      pin_hash: await hashPin(pin, salt),
      failed_attempts: 0,
      locked_until: null,
      factor_changed_at: new Date().toISOString()
    });
    return { replaced: !!before?.pin_hash };
  }

  /** Removes the PIN. Returns false if none was set. Authorising the removal is the caller's job. */
  async removePin(userId: string): Promise<boolean> {
    const c = await this.get(userId);
    if (!c?.pin_hash) return false;
    await this.patch(userId, { pin_salt: null, pin_hash: null });
    return true;
  }

  /** Removes the authenticator app (and any half-finished setup). Returns false if none was set. */
  async removeTotp(userId: string): Promise<boolean> {
    const c = await this.get(userId);
    if (!c?.totp_secret_enc) return false;
    await this.patch(userId, { totp_secret_enc: null, totp_pending_secret_enc: null, totp_confirmed_at: null });
    return true;
  }

  /** Shared lockout gate (cheap pre-check; the authoritative decision is made atomically in registerAttempt). */
  private lockedResult(c: Cred): VerifyResult | null {
    if (c.locked_until && new Date(c.locked_until).getTime() > Date.now()) {
      return { ok: false, code: 'LOCKED', lockedUntil: c.locked_until };
    }
    return null;
  }

  /**
   * Records ONE verification attempt and decides lockout in a single atomic step, so concurrent guesses can never be
   * under-counted (the read-modify-write race: N requests all read failed_attempts=0 and all write 1).
   *
   *  - PostgreSQL: the `step_up_register_attempt` function (migration 009): one UPDATE ... RETURNING whose WHERE clause
   *    refuses to touch a row that is currently locked.
   *  - Local driver: the same rules inside a per-user async mutex.
   *
   * Semantics (identical in both):
   *  - already locked            -> 'locked', nothing is changed (a locked account never counts further attempts and a
   *                                 correct code can NOT unlock it, even if it was already in flight)
   *  - success                   -> counter reset, 'ok'
   *  - failure                   -> counter + 1; reaching MAX_FAILED_ATTEMPTS resets it to 0 and locks for LOCK_MINUTES
   */
  private async registerAttempt(userId: string, success: boolean): Promise<AttemptOutcome> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.rpc('step_up_register_attempt', {
        p_user_id: userId,
        p_success: success,
        p_max_attempts: MAX_FAILED_ATTEMPTS,
        p_lock_minutes: LOCK_MINUTES
      });
      if (error) throw new UpstreamError(`[StepUp] attempt write failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { o_outcome: string; o_failed_attempts: number; o_locked_until: string | null } | undefined;
      if (row?.o_outcome === 'ok') return { outcome: 'ok' };
      if (row?.o_outcome === 'locked' && row.o_locked_until) return { outcome: 'locked', lockedUntil: new Date(row.o_locked_until).toISOString() };
      // 'bad', or 'none' (row vanished mid-verification): fail closed.
      return { outcome: 'bad', attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - (row?.o_failed_attempts ?? MAX_FAILED_ATTEMPTS)) };
    }
    return withUserLock(userId, () => {
      const c = localDb.step_up.get(userId);
      if (!c) return { outcome: 'bad' as const, attemptsLeft: 0 };
      if (c.locked_until && new Date(c.locked_until).getTime() > Date.now()) {
        return { outcome: 'locked' as const, lockedUntil: c.locked_until };
      }
      if (success) {
        c.failed_attempts = 0;
        c.locked_until = null;
        return { outcome: 'ok' as const };
      }
      const failed = c.failed_attempts + 1;
      if (failed >= MAX_FAILED_ATTEMPTS) {
        c.failed_attempts = 0;
        c.locked_until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
        return { outcome: 'locked' as const, lockedUntil: c.locked_until };
      }
      c.failed_attempts = failed;
      return { outcome: 'bad' as const, attemptsLeft: MAX_FAILED_ATTEMPTS - failed };
    });
  }

  private toResult(a: AttemptOutcome): VerifyResult {
    if (a.outcome === 'ok') return { ok: true };
    if (a.outcome === 'locked') return { ok: false, code: 'LOCKED', lockedUntil: a.lockedUntil };
    return { ok: false, code: 'BAD_CODE', attemptsLeft: a.attemptsLeft };
  }

  async verifyPin(userId: string, pin: string): Promise<VerifyResult> {
    const c = await this.get(userId);
    if (!c || !c.pin_hash || !c.pin_salt) return { ok: false, code: 'NOT_ENROLLED' };
    const locked = this.lockedResult(c);
    if (locked) return locked;
    const candidate = Buffer.from(await hashPin(typeof pin === 'string' ? pin : '', c.pin_salt), 'hex');
    const stored = Buffer.from(c.pin_hash, 'hex');
    const match = candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
    return this.toResult(await this.registerAttempt(userId, match));
  }

  // ---- TOTP ------------------------------------------------------------------------------------------------

  /**
   * Starts (or restarts) TOTP enrollment. The new secret is stored sealed in a *pending* slot, so an abandoned
   * enrollment never disturbs a working authenticator. Returns the secret ONCE for the QR code; it is never
   * readable through any other endpoint.
   */
  async beginTotpEnrollment(userId: string, accountLabel: string): Promise<{ secret: string; otpauthUri: string }> {
    const raw = generateTotpSecret();
    await this.patch(userId, { totp_pending_secret_enc: sealSecret(raw, config.STEP_UP_ENC_KEY) });
    const secret = base32Encode(raw);
    return { secret, otpauthUri: buildOtpAuthUri(secret, accountLabel) };
  }

  /**
   * Activates the pending secret iff `code` is valid for it. Failures count toward the shared lockout. Activation
   * starts the enrollment cooldown; `replaced` is true when an authenticator was already set up.
   */
  async confirmTotpEnrollment(userId: string, code: string): Promise<VerifyResult> {
    const c = await this.get(userId);
    if (!c || !c.totp_pending_secret_enc) return { ok: false, code: 'NOT_ENROLLED' };
    const locked = this.lockedResult(c);
    if (locked) return locked;
    const step = matchTotp(openSecret(c.totp_pending_secret_enc, config.STEP_UP_ENC_KEY), code, Date.now());
    const attempt = await this.registerAttempt(userId, step !== null);
    if (attempt.outcome !== 'ok' || step === null) return this.toResult(attempt);
    await this.patch(userId, {
      totp_secret_enc: c.totp_pending_secret_enc,
      totp_pending_secret_enc: null,
      totp_confirmed_at: new Date().toISOString(),
      totp_last_step: step,
      factor_changed_at: new Date().toISOString()
    });
    return { ok: true, replaced: !!c.totp_secret_enc };
  }

  /**
   * Verifies an authenticator-app code. A 30-second time step can be accepted ONCE: the last accepted step is stored
   * and advanced with an atomic compare-and-swap, so replaying a code (or racing two requests with the same code) is
   * rejected. A rejected replay counts as a failed attempt.
   */
  async verifyTotp(userId: string, code: string): Promise<VerifyResult> {
    const c = await this.get(userId);
    if (!c || !c.totp_secret_enc) return { ok: false, code: 'NOT_ENROLLED' };
    const locked = this.lockedResult(c);
    if (locked) return locked;
    const step = matchTotp(openSecret(c.totp_secret_enc, config.STEP_UP_ENC_KEY), typeof code === 'string' ? code : '', Date.now());
    const accepted = step !== null && step > (c.totp_last_step ?? 0) && (await this.advanceTotpStep(userId, step));
    return this.toResult(await this.registerAttempt(userId, accepted));
  }

  /** Compare-and-swap: only moves the replay counter forward. */
  private async advanceTotpStep(userId: string, step: number): Promise<boolean> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('step_up_credentials')
        .update({ totp_last_step: step, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .lt('totp_last_step', step)
        .select('user_id');
      if (error) throw new UpstreamError(`[StepUp] write failed: ${error.message}`);
      return (data ?? []).length === 1;
    }
    return withUserLock(userId, () => {
      const c = localDb.step_up.get(userId);
      if (!c || (c.totp_last_step ?? 0) >= step) return false;
      c.totp_last_step = step;
      return true;
    });
  }
}

export const stepUpRepo = new StepUpRepo();
