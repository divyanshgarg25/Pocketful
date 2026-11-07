import crypto from 'crypto';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type PublicKeyCredentialCreationOptionsJSON
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { ConflictError, ValidationError, type ErrorCode } from '../core/errors.js';
import { stepUpRepo, type VerifyResult } from '../repos/stepup.js';
import { auditRepo } from '../repos/audit.js';
import { securityNotificationsRepo, type SecurityNotification } from '../repos/securityNotifications.js';
import { webauthnRepo, MAX_PASSKEYS_PER_USER } from '../repos/webauthn.js';
import type { Approval } from '../schemas/domain.js';

// ---------------------------------------------------------------------------------------------------------
// Proof schema: what a client may send to prove "a human with a real factor approved exactly this".
// ---------------------------------------------------------------------------------------------------------

const b64u = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9_-]*$/, 'must be base64url');

const AssertionSchema = z.object({
  id: b64u(1024),
  rawId: b64u(1024),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64u(4096),
    authenticatorData: b64u(2048),
    signature: b64u(2048),
    userHandle: b64u(256).optional()
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({})
});

const AttestationSchema = z.object({
  id: b64u(1024),
  rawId: b64u(1024),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64u(4096),
    attestationObject: b64u(16384),
    transports: z.array(z.string().max(32)).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: b64u(2048).optional(),
    authenticatorData: b64u(4096).optional()
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({})
});

export const StepUpProofSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('passkey'), assertion: AssertionSchema }),
  z.object({ method: z.literal('totp'), code: z.string().regex(/^\d{6}$/) }),
  z.object({ method: z.literal('pin'), pin: z.string().max(32) }),
  z.object({ method: z.literal('test'), testProof: z.string().regex(/^[0-9a-f]{64}$/) })
]);
export type StepUpProof = z.infer<typeof StepUpProofSchema>;
export const PasskeyAttestationSchema = AttestationSchema;

export type StepUpMethod = StepUpProof['method'];

export interface StepUpMethods {
  passkeys: number;
  totp: boolean;
  pin: boolean;
  /** True only when the software test authenticator is active (never in production). */
  test: boolean;
  enrolled: boolean;
  methods: StepUpMethod[];
  lockedUntil: string | null;
  /** Seconds until a newly enrolled/replaced/reset factor may approve money actions (0 = no cooldown running). */
  cooldownRemainingSeconds: number;
}

export type StepUpFailure = { ok: false; status: number; code: ErrorCode; message: string; details?: unknown };
export type StepUpOk = { ok: true; method: StepUpMethod };

// ---------------------------------------------------------------------------------------------------------
// Challenge binding
// ---------------------------------------------------------------------------------------------------------

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]));
  }
  return v;
}

const sha256Hex = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');

/**
 * Fingerprint of everything the user is approving:
 * sha256(approvalId | userId | action_type | amount_minor | money_out_minor | canonical(payload) | expires_at).
 * Recomputed server-side at verification time, so any change to the approval after the challenge was issued
 * invalidates it.
 */
export function computeApprovalFingerprint(a: Approval): string {
  return sha256Hex(
    JSON.stringify([a.id, a.user_id, a.action_type, a.amount_minor, a.money_out_minor ?? 0, canon(a.payload), a.expires_at])
  );
}

/**
 * The 32-byte challenge the authenticator actually signs: sha256("pocketful-stepup-v1" | nonce | fingerprint).
 * It commits to BOTH the single-use server nonce and the approval fingerprint, so a signature made for one
 * approval (or one issuance) is worthless for any other.
 */
export function deriveApprovalChallenge(nonce: string, fingerprint: string): Buffer {
  return crypto.createHash('sha256').update(`pocketful-stepup-v1|${nonce}|${fingerprint}`).digest();
}

export const challengeToString = (bytes: Uint8Array): string => isoBase64URL.fromBuffer(new Uint8Array(bytes));

/** What the test authenticator signs: HMAC-SHA256(STEP_UP_TEST_SECRET, base64url challenge). Test mode only. */
export function testAuthenticatorProof(challengeB64u: string, secret = config.STEP_UP_TEST_SECRET): string {
  return crypto.createHmac('sha256', secret).update(challengeB64u).digest('hex');
}

/** Hard double guard: the flag AND not-production. Config already refuses to boot with the flag in production. */
const testModeActive = (): boolean => config.STEP_UP_TEST_MODE === true && config.NODE_ENV !== 'production';

// ---------------------------------------------------------------------------------------------------------
// Methods / status
// ---------------------------------------------------------------------------------------------------------

export async function getStepUpMethods(userId: string): Promise<StepUpMethods> {
  const [factors, passkeys] = await Promise.all([stepUpRepo.status(userId), webauthnRepo.list(userId)]);
  const test = testModeActive();
  const methods: StepUpMethod[] = [];
  if (passkeys.length > 0) methods.push('passkey');
  if (factors.totp) methods.push('totp');
  if (factors.pin) methods.push('pin');
  if (test) methods.push('test');
  return {
    passkeys: passkeys.length,
    totp: factors.totp,
    pin: factors.pin,
    test,
    // The test authenticator is a proof method for tests, NOT enrollment: a real factor is still required unless
    // test mode is on, in which case it stands in for one so e2e flows can run without hardware.
    enrolled: methods.length > 0,
    methods,
    lockedUntil: factors.lockedUntil,
    cooldownRemainingSeconds: factors.cooldownRemainingSeconds
  };
}

// ---------------------------------------------------------------------------------------------------------
// H1: enrollment cooldown + fresh-session gate
// ---------------------------------------------------------------------------------------------------------

/** How recent the session token's `iat` must be to enroll the FIRST step-up factor. */
export const FRESH_SESSION_SECONDS = 5 * 60;

/**
 * A factor that was just enrolled, replaced or reset cannot approve money actions until the cooldown ends. This is
 * what stops "steal a session, add my own authenticator, drain the account in the same minute": the legitimate owner
 * gets a notification (see recordFactorEvent) and a full cooldown window to react.
 * Returns a failure to send to the client, or null when approving is allowed.
 */
export async function checkEnrollmentCooldown(userId: string): Promise<StepUpFailure | null> {
  const remainingSeconds = await stepUpRepo.cooldownRemainingSeconds(userId);
  if (remainingSeconds <= 0) return null;
  return {
    ok: false,
    status: 403,
    code: 'STEP_UP_COOLDOWN',
    message: 'A verification method was recently added or changed, so it cannot approve money actions yet.',
    details: { remainingSeconds }
  };
}

/**
 * First-ever enrollment is trust-on-first-use (nothing to prove against), so it demands a session that was issued
 * moments ago: a token lifted from an old browser tab or log is not enough to claim the account's step-up.
 * Fails closed when the token carries no usable `iat`.
 */
export function checkFreshSession(sessionIssuedAt: number | undefined, nowMs = Date.now()): StepUpFailure | null {
  const ageSeconds = sessionIssuedAt === undefined ? Number.POSITIVE_INFINITY : nowMs / 1000 - sessionIssuedAt;
  if (ageSeconds <= FRESH_SESSION_SECONDS && ageSeconds >= -60) return null;
  return {
    ok: false,
    status: 403,
    code: 'FRESH_SESSION_REQUIRED',
    message: 'Please sign in again, then set up your first verification method right away.'
  };
}

export type FactorKind = 'pin' | 'totp' | 'passkey';
export type FactorEvent = 'enrolled' | 'replaced' | 'removed';
const FACTOR_LABEL: Record<FactorKind, string> = { pin: 'PIN', totp: 'authenticator app', passkey: 'passkey' };

/**
 * Every enrollment, replacement and removal writes an audit row AND a notification the user can see. Neither ever
 * holds a PIN, secret or code. A failure here is logged loudly but never undoes a change that has already happened.
 */
export async function recordFactorEvent(
  userId: string,
  requestId: string | undefined,
  event: FactorEvent,
  factor: FactorKind
): Promise<void> {
  const hours = config.STEPUP_ENROLL_COOLDOWN_HOURS;
  const label = FACTOR_LABEL[factor];
  const cooldownNote = event !== 'removed' && hours > 0 ? ` For your protection it cannot approve money actions for ${hours} hour${hours === 1 ? '' : 's'}.` : '';
  const messages: Record<FactorEvent, string> = {
    enrolled: `A ${label} was added to approve money actions on your account.${cooldownNote} If this wasn't you, remove it and sign out everywhere.`,
    replaced: `Your ${label} was changed.${cooldownNote} If this wasn't you, remove it and sign out everywhere.`,
    removed: `A ${label} was removed from your account. If this wasn't you, sign out everywhere and set up your verification methods again.`
  };
  try {
    await auditRepo.log({
      user_id: userId,
      request_id: requestId ?? null,
      agent: 'step_up',
      action: `factor_${event}`,
      params: { factor },
      result: { cooldownHours: event === 'removed' ? 0 : hours }
    });
    await securityNotificationsRepo.add({ user_id: userId, kind: `factor_${event}` as SecurityNotification['kind'], factor, message: messages[event] });
  } catch (err) {
    logger.error('[StepUp] could not record factor change', undefined, { event, factor, error: err instanceof Error ? err.message.slice(0, 160) : 'unknown' });
  }
}

export async function passkeyRequestOptions(userId: string, challenge: Buffer): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const creds = await webauthnRepo.list(userId);
  return generateAuthenticationOptions({
    rpID: config.WEBAUTHN_RP_ID,
    challenge: new Uint8Array(challenge),
    userVerification: 'required',
    timeout: 60_000,
    allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports ?? undefined }))
  });
}

// ---------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------

function fromRepo(result: VerifyResult, method: 'pin' | 'totp'): StepUpOk | StepUpFailure {
  if (result.ok) return { ok: true, method };
  if (result.code === 'LOCKED') {
    return { ok: false, status: 403, code: 'STEP_UP_LOCKED', message: 'Too many incorrect attempts. Try again later.' };
  }
  if (result.code === 'NOT_ENROLLED') {
    return { ok: false, status: 403, code: 'STEP_UP_FAILED', message: `That verification method is not set up (${method}).` };
  }
  return { ok: false, status: 403, code: 'STEP_UP_FAILED', message: method === 'pin' ? 'Incorrect PIN.' : 'Incorrect code.' };
}

async function verifyPasskey(
  userId: string,
  assertion: z.infer<typeof AssertionSchema>,
  expectedChallengeB64u: string
): Promise<StepUpOk | StepUpFailure> {
  const fail = (message = 'Passkey verification failed.'): StepUpFailure => ({ ok: false, status: 403, code: 'STEP_UP_FAILED', message });
  const cred = await webauthnRepo.get(userId, assertion.id); // scoped to THIS user
  if (!cred) return fail();
  try {
    const verification = await verifyAuthenticationResponse({
      response: assertion as unknown as AuthenticationResponseJSON,
      expectedChallenge: expectedChallengeB64u,
      expectedOrigin: config.WEBAUTHN_ORIGINS,
      expectedRPID: config.WEBAUTHN_RP_ID,
      requireUserVerification: true,
      credential: {
        id: cred.credential_id,
        publicKey: isoBase64URL.toBuffer(cred.public_key),
        counter: Number(cred.counter),
        transports: (cred.transports ?? undefined) as never
      }
    });
    if (!verification.verified) return fail();
    const moved = await webauthnRepo.recordUse(userId, cred.credential_id, Number(cred.counter), verification.authenticationInfo.newCounter);
    if (!moved) return fail('Passkey state changed during verification. Try again.');
    return { ok: true, method: 'passkey' };
  } catch (err) {
    // Library errors describe *why* (origin, rpId, counter, signature). Log a short summary for operators; the
    // client only ever sees the generic message.
    logger.warn('[StepUp] passkey assertion rejected', { reason: err instanceof Error ? err.message.slice(0, 160) : 'unknown' });
    return fail();
  }
}

/**
 * Verifies one factor against the challenge the server issued (passkey/test sign it; PIN/TOTP ignore it - for those
 * the single-use nonce binding is enforced by the caller).
 */
export async function verifyFactor(
  userId: string,
  proof: StepUpProof,
  expectedChallengeB64u: string
): Promise<StepUpOk | StepUpFailure> {
  switch (proof.method) {
    case 'passkey':
      return verifyPasskey(userId, proof.assertion, expectedChallengeB64u);
    case 'totp':
      return fromRepo(await stepUpRepo.verifyTotp(userId, proof.code), 'totp');
    case 'pin':
      return fromRepo(await stepUpRepo.verifyPin(userId, proof.pin), 'pin');
    case 'test': {
      if (!testModeActive()) {
        return { ok: false, status: 403, code: 'STEP_UP_FAILED', message: 'That verification method is not available.' };
      }
      const given = Buffer.from(proof.testProof, 'hex');
      const expected = Buffer.from(testAuthenticatorProof(expectedChallengeB64u), 'hex');
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return { ok: false, status: 403, code: 'STEP_UP_FAILED', message: 'Test authenticator proof rejected.' };
      }
      return { ok: true, method: 'test' };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Authorising a change to the user's own factors (enrol / replace PIN, TOTP, passkey)
// ---------------------------------------------------------------------------------------------------------

/**
 * First-ever factor: allowed with just the session (trust-on-first-use; documented in SECURITY.md - enrol during
 * onboarding). After that, adding or changing ANY factor needs a proof from an existing one, so a stolen session
 * cannot quietly add its own authenticator and then approve money actions.
 *
 * `passkey`/`test` proofs here are signed over the single-use 'enroll' challenge from `issueEnrollChallenge`.
 */
export async function authorizeFactorChange(
  userId: string,
  proof: StepUpProof | undefined
): Promise<StepUpOk | StepUpFailure | { ok: true; method: 'first-factor' }> {
  const m = await getStepUpMethods(userId);
  const realFactors = m.passkeys > 0 || m.totp || m.pin;
  if (!realFactors) return { ok: true, method: 'first-factor' };
  if (!proof) {
    return { ok: false, status: 403, code: 'STEP_UP_REQUIRED', message: 'Verify with an existing method to change your step-up settings.' };
  }
  let expected = '';
  if (proof.method === 'passkey' || proof.method === 'test') {
    const challenge = await webauthnRepo.consumeChallenge(userId, 'enroll');
    if (!challenge) {
      return { ok: false, status: 403, code: 'STEP_UP_CHALLENGE_EXPIRED', message: 'Challenge missing or expired. Request a new one.' };
    }
    expected = challenge;
  }
  return verifyFactor(userId, proof, expected);
}

/** Issues the single-use challenge a passkey/test proof must sign to authorise a factor change. */
export async function issueEnrollChallenge(userId: string): Promise<{
  passkeyOptions?: PublicKeyCredentialRequestOptionsJSON;
  testChallenge?: string;
  methods: StepUpMethod[];
}> {
  const m = await getStepUpMethods(userId);
  const challenge = crypto.randomBytes(32);
  await webauthnRepo.putChallenge(userId, 'enroll', challengeToString(challenge));
  return {
    methods: m.methods,
    ...(m.passkeys > 0 ? { passkeyOptions: await passkeyRequestOptions(userId, challenge) } : {}),
    ...(m.test ? { testChallenge: challengeToString(challenge) } : {})
  };
}

// ---------------------------------------------------------------------------------------------------------
// Passkey registration ceremony
// ---------------------------------------------------------------------------------------------------------

export async function beginPasskeyRegistration(userId: string, accountName: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await webauthnRepo.list(userId);
  if (existing.length >= MAX_PASSKEYS_PER_USER) throw new ConflictError(`You can register at most ${MAX_PASSKEYS_PER_USER} passkeys.`);
  const options = await generateRegistrationOptions({
    rpName: config.WEBAUTHN_RP_NAME,
    rpID: config.WEBAUTHN_RP_ID,
    userName: accountName,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    timeout: 60_000,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports ?? undefined }))
  });
  await webauthnRepo.putChallenge(userId, 'register', options.challenge);
  return options;
}

export async function completePasskeyRegistration(
  userId: string,
  attestation: z.infer<typeof AttestationSchema>,
  label?: string
): Promise<{ id: string; credentialId: string }> {
  const expectedChallenge = await webauthnRepo.consumeChallenge(userId, 'register');
  if (!expectedChallenge) throw new ValidationError('Registration challenge missing or expired. Start again.');
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: attestation as unknown as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: config.WEBAUTHN_ORIGINS,
      expectedRPID: config.WEBAUTHN_RP_ID,
      requireUserVerification: true
    });
  } catch (err) {
    logger.warn('[StepUp] passkey registration rejected', { reason: err instanceof Error ? err.message.slice(0, 160) : 'unknown' });
    throw new ValidationError('Passkey registration could not be verified.');
  }
  if (!verification.verified || !verification.registrationInfo) throw new ValidationError('Passkey registration could not be verified.');
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  // Start the cooldown BEFORE the credential exists: a crash in between leaves a harmless cooldown, never a gap.
  await stepUpRepo.markFactorChanged(userId);
  const row = await webauthnRepo.create({
    user_id: userId,
    credential_id: credential.id,
    public_key: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: (credential.transports as string[] | undefined) ?? null,
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp,
    label: label ? label.slice(0, 64) : null
  });
  return { id: row.id, credentialId: row.credential_id };
}
