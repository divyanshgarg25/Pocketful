import { Router } from 'express';
import { z } from 'zod';
import { stepUpRepo } from '../repos/stepup.js';
import { webauthnRepo } from '../repos/webauthn.js';
import { getAuthReq, type AuthenticatedRequest } from '../core/auth.js';
import { securityNotificationsRepo } from '../repos/securityNotifications.js';
import { sendSuccess, handleRouteError, sendError, ValidationError, NotFoundError } from '../core/errors.js';
import {
  StepUpProofSchema,
  PasskeyAttestationSchema,
  authorizeFactorChange,
  checkFreshSession,
  recordFactorEvent,
  beginPasskeyRegistration,
  completePasskeyRegistration,
  getStepUpMethods,
  issueEnrollChallenge,
  type StepUpProof
} from '../services/stepup.js';

export const stepUpRouter = Router();

const accountTag = (userId: string): string => `account-${userId.slice(0, 8)}`;

/**
 * Body shape shared by every endpoint that changes the user's factors: an optional proof from an EXISTING factor
 * (`proof`), with `currentPin` kept as a shorthand for { method: 'pin', pin }.
 */
const FactorChangeAuth = z.object({
  proof: StepUpProofSchema.optional(),
  currentPin: z.string().max(32).optional()
});

function proofOf(body: z.infer<typeof FactorChangeAuth>): StepUpProof | undefined {
  if (body.proof) return body.proof;
  if (body.currentPin) return { method: 'pin', pin: body.currentPin };
  return undefined;
}

/**
 * Returns true (and has already replied) when the change is NOT authorised.
 * Changing an existing setup needs proof from an existing factor. The FIRST factor has nothing to prove against, so it
 * instead needs a fresh session (`iat` within 5 minutes).
 */
async function denyUnlessAuthorized(
  res: Parameters<typeof sendError>[0],
  authReq: AuthenticatedRequest,
  proof: StepUpProof | undefined
): Promise<boolean> {
  const auth = await authorizeFactorChange(authReq.userId, proof);
  if (!auth.ok) {
    sendError(res, auth.code, auth.message, auth.status, undefined, authReq.requestId);
    return true;
  }
  if (auth.method === 'first-factor') {
    const stale = checkFreshSession(authReq.sessionIssuedAt);
    if (stale) {
      sendError(res, stale.code, stale.message, stale.status, undefined, authReq.requestId);
      return true;
    }
  }
  return false;
}

/** True when, after a removal, the user has no real factor left (the next enrollment is a first enrollment again). */
async function hasNoFactorsLeft(userId: string): Promise<boolean> {
  const m = await getStepUpMethods(userId);
  return m.passkeys === 0 && !m.totp && !m.pin;
}

stepUpRouter.get('/api/auth/step-up', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const m = await getStepUpMethods(authReq.userId);
    sendSuccess(
      res,
      {
        enrolled: m.enrolled,
        methods: m.methods,
        passkeys: m.passkeys,
        totp: m.totp,
        pin: m.pin,
        lockedUntil: m.lockedUntil,
        cooldownRemainingSeconds: m.cooldownRemainingSeconds
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

/** Single-use challenge that a passkey/test proof must sign to authorise changing your own factors. */
stepUpRouter.post('/api/auth/step-up/challenge', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    sendSuccess(res, await issueEnrollChallenge(authReq.userId), authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const SetPinSchema = FactorChangeAuth.extend({ pin: z.string().max(32) });

stepUpRouter.put('/api/auth/step-up/pin', async (req, res) => {
  const authReq = getAuthReq(req);
  const parsed = SetPinSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Invalid request body.', 400, undefined, authReq.requestId);
    return;
  }
  try {
    if (await denyUnlessAuthorized(res, authReq, proofOf(parsed.data))) return;
    const { replaced } = await stepUpRepo.setPin(authReq.userId, parsed.data.pin);
    await recordFactorEvent(authReq.userId, authReq.requestId, replaced ? 'replaced' : 'enrolled', 'pin');
    sendSuccess(res, { enrolled: true }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

/** Starts TOTP enrollment. The secret is returned once, here, and is never readable again. */
stepUpRouter.post('/api/auth/step-up/totp/enroll', async (req, res) => {
  const authReq = getAuthReq(req);
  const parsed = FactorChangeAuth.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Invalid request body.', 400, undefined, authReq.requestId);
    return;
  }
  try {
    if (await denyUnlessAuthorized(res, authReq, proofOf(parsed.data))) return;
    const out = await stepUpRepo.beginTotpEnrollment(authReq.userId, accountTag(authReq.userId));
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, out, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const TotpConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

stepUpRouter.post('/api/auth/step-up/totp/confirm', async (req, res) => {
  const authReq = getAuthReq(req);
  const parsed = TotpConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Enter the 6-digit code from your authenticator app.', 400, undefined, authReq.requestId);
    return;
  }
  try {
    const r = await stepUpRepo.confirmTotpEnrollment(authReq.userId, parsed.data.code);
    if (r.ok) {
      await recordFactorEvent(authReq.userId, authReq.requestId, r.replaced ? 'replaced' : 'enrolled', 'totp');
      sendSuccess(res, { enrolled: true }, authReq.requestId);
    } else if (r.code === 'LOCKED') {
      sendError(res, 'STEP_UP_LOCKED', 'Too many incorrect attempts. Try again later.', 403, undefined, authReq.requestId);
    } else if (r.code === 'NOT_ENROLLED') {
      sendError(res, 'VALIDATION_FAILED', 'Start authenticator setup first.', 400, undefined, authReq.requestId);
    } else {
      sendError(res, 'STEP_UP_FAILED', 'Incorrect code.', 403, undefined, authReq.requestId);
    }
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

// ---- Passkeys ------------------------------------------------------------------------------------------------

stepUpRouter.get('/api/auth/passkeys', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const creds = await webauthnRepo.list(authReq.userId);
    sendSuccess(
      res,
      {
        passkeys: creds.map((c) => ({
          id: c.id,
          label: c.label,
          deviceType: c.device_type,
          backedUp: c.backed_up,
          createdAt: c.created_at,
          lastUsedAt: c.last_used_at
        }))
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

stepUpRouter.post('/api/auth/passkeys/register/options', async (req, res) => {
  const authReq = getAuthReq(req);
  const parsed = FactorChangeAuth.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Invalid request body.', 400, undefined, authReq.requestId);
    return;
  }
  try {
    if (await denyUnlessAuthorized(res, authReq, proofOf(parsed.data))) return;
    const options = await beginPasskeyRegistration(authReq.userId, accountTag(authReq.userId));
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { options }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const RegisterVerifySchema = z.object({
  attestation: PasskeyAttestationSchema,
  label: z.string().trim().min(1).max(64).optional()
});

stepUpRouter.post('/api/auth/passkeys/register/verify', async (req, res) => {
  const authReq = getAuthReq(req);
  const parsed = RegisterVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Invalid passkey registration payload.', 400, undefined, authReq.requestId);
    return;
  }
  try {
    const out = await completePasskeyRegistration(authReq.userId, parsed.data.attestation, parsed.data.label);
    await recordFactorEvent(authReq.userId, authReq.requestId, 'enrolled', 'passkey');
    sendSuccess(res, { registered: true, id: out.id }, authReq.requestId);
  } catch (err) {
    if (err instanceof ValidationError) {
      sendError(res, 'VALIDATION_FAILED', err.message, 400, undefined, authReq.requestId);
      return;
    }
    handleRouteError(res, err, authReq.requestId);
  }
});

// ---- Removal ---------------------------------------------------------------------------------------------------
// Removing ANY factor needs proof from an existing one (so a stolen session cannot strip protections), including the
// last one. Removing the last factor also restarts the cooldown, so the next enrollment starts from scratch.

const RemoveSchema = FactorChangeAuth;

async function removeFactor(
  req: Parameters<typeof getAuthReq>[0],
  res: Parameters<typeof sendError>[0],
  factor: 'pin' | 'totp'
): Promise<void> {
  const authReq = getAuthReq(req);
  const parsed = RemoveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Invalid request body.', 400, undefined, authReq.requestId);
    return;
  }
  try {
    const m = await getStepUpMethods(authReq.userId);
    if (!(factor === 'pin' ? m.pin : m.totp)) throw new NotFoundError(`No ${factor === 'pin' ? 'PIN' : 'authenticator app'} is set up.`);
    if (await denyUnlessAuthorized(res, authReq, proofOf(parsed.data))) return;
    const removed = factor === 'pin' ? await stepUpRepo.removePin(authReq.userId) : await stepUpRepo.removeTotp(authReq.userId);
    if (!removed) throw new NotFoundError(`No ${factor === 'pin' ? 'PIN' : 'authenticator app'} is set up.`);
    if (await hasNoFactorsLeft(authReq.userId)) await stepUpRepo.markFactorChanged(authReq.userId);
    await recordFactorEvent(authReq.userId, authReq.requestId, 'removed', factor);
    sendSuccess(res, { removed: true }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
}

stepUpRouter.delete('/api/auth/step-up/pin', (req, res) => removeFactor(req, res, 'pin'));
stepUpRouter.delete('/api/auth/step-up/totp', (req, res) => removeFactor(req, res, 'totp'));

stepUpRouter.delete('/api/auth/passkeys/:id', async (req, res) => {
  const authReq = getAuthReq(req);
  const parsed = RemoveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Invalid request body.', 400, undefined, authReq.requestId);
    return;
  }
  try {
    const id = req.params['id'] as string;
    const mine = (await webauthnRepo.list(authReq.userId)).some((c) => c.id === id);
    if (!mine) throw new NotFoundError('Passkey not found.');
    if (await denyUnlessAuthorized(res, authReq, proofOf(parsed.data))) return;
    if (!(await webauthnRepo.remove(authReq.userId, id))) throw new NotFoundError('Passkey not found.');
    if (await hasNoFactorsLeft(authReq.userId)) await stepUpRepo.markFactorChanged(authReq.userId);
    await recordFactorEvent(authReq.userId, authReq.requestId, 'removed', 'passkey');
    sendSuccess(res, { removed: true }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

// ---- Notifications ---------------------------------------------------------------------------------------------

/** The user's own factor-change notifications, newest first (shown on the You screen). */
stepUpRouter.get('/api/auth/security-notifications', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const rows = await securityNotificationsRepo.list(authReq.userId, 20);
    sendSuccess(
      res,
      { notifications: rows.map((n) => ({ id: n.id, kind: n.kind, factor: n.factor, message: n.message, created_at: n.created_at })) },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
