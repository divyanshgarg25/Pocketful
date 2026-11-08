import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { approvalsRepo } from '../repos/approvals.js';
import {
  StepUpProofSchema,
  computeApprovalFingerprint,
  deriveApprovalChallenge,
  challengeToString,
  checkEnrollmentCooldown,
  getStepUpMethods,
  passkeyRequestOptions,
  verifyFactor,
  type StepUpProof
} from '../services/stepup.js';
import { assertCurrencyChangeAllowed } from '../services/currency.js';
import { moneyService } from '../services/money.js';
import { profilesRepo } from '../repos/profiles.js';
import { vaultRepo } from '../repos/vault.js';
import { auditorAgent } from '../agents/auditor.js';
import { splitterAgent } from '../agents/splitter.js';
import { banditRepo } from '../repos/bandit.js';
import { auditRepo } from '../repos/audit.js';
import { erasedUsersRepo } from '../repos/erasedUsers.js';
import { isRemoteSupabaseEnabled, supabaseClient } from '../core/database.js';
import { logger } from '../core/logger.js';
import { isSupportedCurrency } from '../core/currency.js';
import {
  sendSuccess,
  handleRouteError,
  sendError,
  NotFoundError,
  ValidationError,
  GuardianBlockedError,
  ApprovalExpiredError,
  ConflictError,
  AppError,
  UpstreamError,
  type ErrorCode
} from '../core/errors.js';
import { getAuthReq } from '../core/auth.js';
import type { Approval } from '../schemas/domain.js';

export const approvalsRouter = Router();

// In-memory per-user locks for in-flight request optimization
const inFlightUserLocks = new Set<string>();

type StepUpFailure = { ok: false; status: number; code: ErrorCode; message: string; details?: unknown };

/**
 * Step-up = something the bearer token alone cannot produce, bound to exactly this approval:
 *  1. a single-use server nonce, issued by /challenge and stored on the approval together with a fingerprint of
 *     everything being approved (see computeApprovalFingerprint);
 *  2. a proof from a real factor: a WebAuthn assertion that signs a challenge derived from nonce + fingerprint
 *     (primary), or a TOTP code / PIN (fallbacks, shared lockout).
 * The nonce is consumed with an atomic compare-and-swap AFTER the factor verifies, so two concurrent requests can
 * never both spend it. The server never returns anything from which a proof could be derived.
 */
async function verifyStepUp(
  input: { proof?: StepUpProof; challengeNonce?: string },
  approval: Approval,
  userId: string
): Promise<{ ok: true } | StepUpFailure> {
  const methods = await getStepUpMethods(userId);
  if (!methods.enrolled) {
    return { ok: false, status: 403, code: 'STEP_UP_NOT_ENROLLED', message: 'Set up a passkey, authenticator app, or PIN before approving money actions.' };
  }
  const cooling = await checkEnrollmentCooldown(userId);
  if (cooling) return cooling;
  if (!input.proof || !input.challengeNonce) {
    return { ok: false, status: 403, code: 'STEP_UP_REQUIRED', message: 'A verification proof and challenge nonce are required.' };
  }
  if (!approval.challenge_nonce || !approval.challenge_fingerprint) {
    return { ok: false, status: 403, code: 'STEP_UP_CHALLENGE_REQUIRED', message: 'Request a challenge first.' };
  }
  if (approval.challenge_expires_at && new Date(approval.challenge_expires_at).getTime() < Date.now()) {
    return { ok: false, status: 403, code: 'STEP_UP_CHALLENGE_EXPIRED', message: 'Challenge expired. Request a new one.' };
  }
  const given = Buffer.from(input.challengeNonce);
  const stored = Buffer.from(approval.challenge_nonce);
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    return { ok: false, status: 403, code: 'STEP_UP_CHALLENGE_INVALID', message: 'Challenge does not match.' };
  }
  const fingerprint = computeApprovalFingerprint(approval);
  if (approval.challenge_fingerprint !== fingerprint) {
    return { ok: false, status: 403, code: 'STEP_UP_CHALLENGE_INVALID', message: 'Approval changed after the challenge was issued.' };
  }
  const expectedChallenge = challengeToString(deriveApprovalChallenge(approval.challenge_nonce, fingerprint));
  const v = await verifyFactor(userId, input.proof, expectedChallenge);
  if (!v.ok) return v;
  // single use: atomic compare-and-swap on the stored nonce
  if (!(await approvalsRepo.consumeChallengeNonce(approval.id, userId, approval.challenge_nonce))) {
    return { ok: false, status: 403, code: 'STEP_UP_CHALLENGE_INVALID', message: 'Challenge was already used.' };
  }
  return { ok: true };
}

/** Issues a single-use nonce bound (server-side) to the approval fingerprint. Returns no proof material. */
approvalsRouter.post('/api/approvals/:id/challenge', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const id = req.params['id'] as string;
    const approval = await approvalsRepo.getById(id, authReq.userId);
    if (!approval) {
      sendError(res, 'NOT_FOUND', 'Approval record not found.', 404);
      return;
    }
    if (approval.status !== 'pending' && approval.status !== 'failed') {
      sendError(res, 'VALIDATION_FAILED', `Challenge cannot be generated for approval with status "${approval.status}".`, 400);
      return;
    }
    if (approval.status === 'pending' && new Date(approval.expires_at) < new Date()) {
      await approvalsRepo.updateStatus(id, 'expired', undefined, authReq.userId);
      sendError(res, 'APPROVAL_EXPIRED', 'This approval request has expired (10-minute limit).', 410);
      return;
    }
    const methods = await getStepUpMethods(authReq.userId);
    if (!methods.enrolled) {
      sendError(res, 'STEP_UP_NOT_ENROLLED', 'Set up a passkey, authenticator app, or PIN before approving money actions.', 403);
      return;
    }
    const cooling = await checkEnrollmentCooldown(authReq.userId);
    if (cooling) {
      sendError(res, cooling.code, cooling.message, cooling.status, cooling.details, authReq.requestId);
      return;
    }
    const nonce = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const fingerprint = computeApprovalFingerprint(approval);
    if (!(await approvalsRepo.setChallengeNonce(approval.id, authReq.userId, nonce, expiresAt, fingerprint))) {
      throw new UpstreamError('[Approvals] could not persist challenge');
    }
    const challenge = deriveApprovalChallenge(nonce, fingerprint);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(
      res,
      {
        challengeNonce: nonce,
        expiresAt,
        methods: methods.methods,
        ...(methods.passkeys > 0 ? { passkeyOptions: await passkeyRequestOptions(authReq.userId, challenge) } : {}),
        // Test authenticator only (never present in production): the value a software authenticator signs.
        ...(methods.test ? { testChallenge: challengeToString(challenge) } : {})
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const DecideSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  proof: StepUpProofSchema.optional(),
  challengeNonce: z.string().max(128).optional()
});

/**
 * Submit approval decision: Validates Idempotency-Key, Step-up proof, and uses atomic CAS
 */
approvalsRouter.post('/api/approvals/:id/decide', async (req, res) => {
  const authReq = getAuthReq(req);
  const id = req.params['id'] as string;
  const userLockKey = `${authReq.userId}:${id}`;

  const parsed = DecideSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', `Invalid request body: ${parsed.error.message}`, 400);
    return;
  }
  const { decision, proof, challengeNonce } = parsed.data;

  const idempotencyKey = (req.headers['idempotency-key'] as string) || (req.headers['x-idempotency-key'] as string);
  if (!idempotencyKey) {
    sendError(res, 'VALIDATION_FAILED', 'Missing required Idempotency-Key header on money decision.', 400);
    return;
  }

  const idempRegex = /^[a-zA-Z0-9_-]{16,128}$/;
  if (!idempRegex.test(idempotencyKey)) {
    sendError(
      res,
      'VALIDATION_FAILED',
      'Idempotency-Key header must be a valid UUID, ULID, or alphanumeric token (16-128 characters).',
      400
    );
    return;
  }

  if (inFlightUserLocks.has(userLockKey)) {
    sendError(
      res,
      'CONCURRENT_ACTION',
      'This financial action is already in-flight. Please wait a moment.',
      409,
      undefined,
      authReq.requestId
    );
    return;
  }

  let transitionedToExecuting = false;
  let sideEffectDone = false;
  inFlightUserLocks.add(userLockKey);

  try {
    const approval = await approvalsRepo.getById(id, authReq.userId);
    if (!approval) {
      sendError(res, 'NOT_FOUND', 'Approval record not found.', 404);
      return;
    }

    if (approval.decision_idempotency_key === idempotencyKey) {
      if (
        (decision === 'approve' && approval.status === 'denied') ||
        (decision === 'deny' && (approval.status === 'approved' || approval.status === 'executed'))
      ) {
        sendError(res, 'VALIDATION_FAILED', 'Idempotency key reuse with conflicting decision.', 422);
        return;
      }

      if (approval.decision_response) {
        sendSuccess(res, { ...approval.decision_response, replayed: true }, authReq.requestId);
        return;
      }
    }

    if (approval.status === 'executed') {
      sendSuccess(res, { status: 'executed', result: approval.result, replayed: true }, authReq.requestId);
      return;
    }

    if (approval.status !== 'pending') {
      sendError(res, 'VALIDATION_FAILED', `Approval cannot be decided because status is "${approval.status}".`, 400);
      return;
    }

    if (new Date(approval.expires_at).getTime() < Date.now()) {
      await approvalsRepo.updateStatus(id, 'expired', undefined, authReq.userId);
      sendError(res, 'APPROVAL_EXPIRED', 'This approval request has expired (10-minute limit). Please initiate a new request.', 410);
      return;
    }

    if (decision === 'deny') {
      const responseData = { status: 'denied', approvalId: id };
      const updated = await approvalsRepo.updateStatus(id, 'denied', undefined, authReq.userId, {
        decision_idempotency_key: idempotencyKey,
        decision_response: responseData
      }, ['pending']);
      sendSuccess(res, { status: 'denied', approval: updated }, authReq.requestId);
      return;
    }

    // Step-up verification for approve decisions: strictly verify cryptographic assertion
    const verification = await verifyStepUp({ proof, challengeNonce }, approval, authReq.userId);
    if (!verification.ok) {
      sendError(res, verification.code, verification.message, verification.status, verification.details, authReq.requestId);
      return;
    }

    const approvedRecord = await approvalsRepo.updateStatus(id, 'approved', undefined, authReq.userId, {
      decision_idempotency_key: idempotencyKey
    }, ['pending']);
    if (!approvedRecord) {
      sendError(res, 'CONCURRENT_ACTION', 'Failed to approve. Action may have expired or been modified.', 409);
      return;
    }

    // Atomic: re-checks CURRENT per-action + weekly caps (counting executing/executed) and flips to executing.
    try {
      await approvalsRepo.beginExecution(id, authReq.userId, ['approved']);
    } catch (e) {
      if (e instanceof GuardianBlockedError || e instanceof ApprovalExpiredError) {
        // Never leave a blocked approval sitting in `approved`: cancel it with the reason.
        await approvalsRepo.updateStatus(id, 'cancelled', { error: safeErrorCode(e) }, authReq.userId, undefined, ['approved']);
      }
      if (e instanceof ConflictError) {
        sendError(res, 'CONCURRENT_ACTION', 'Approval is already executing or has expired.', 409);
        return;
      }
      throw e;
    }
    transitionedToExecuting = true;

    const executionResult = await executeApprovalAction(approval, authReq.userId, authReq.requestId);
    sideEffectDone = true;
    // Persist the outcome BEFORE the final status write so a failure here can never trigger a re-run.
    await persistOutcome(approval.id, authReq.userId, executionResult);

    const responsePayload = { status: 'executed', result: executionResult };
    await finalizeExecuted(approval.id, authReq.userId, executionResult, responsePayload);

    sendSuccess(res, responsePayload, authReq.requestId);
  } catch (err) {
    if (sideEffectDone) {
      // Money/side effect already happened: never mark failed (that would allow a second run).
      logger.error('[approvals] post-execution bookkeeping failed; reconciler will finish', undefined, { approvalId: id });
      sendSuccess(res, { status: 'executing', reconciling: true }, authReq.requestId);
    } else {
      if (transitionedToExecuting) {
        await approvalsRepo.updateStatus(id, 'failed', { error: safeErrorCode(err) }, authReq.userId, undefined, ['executing']);
      }
      handleRouteError(res, err, authReq.requestId);
    }
  } finally {
    inFlightUserLocks.delete(userLockKey);
  }
});

approvalsRouter.get('/api/approvals/:id', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const id = req.params['id'] as string;
    const approval = await approvalsRepo.getById(id, authReq.userId);
    if (!approval) {
      sendError(res, 'NOT_FOUND', 'Approval record not found.', 404);
      return;
    }
    sendSuccess(res, { approval }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const MAX_RETRIES = 3;
const RetrySchema = z.object({
  proof: StepUpProofSchema.optional(),
  challengeNonce: z.string().max(128).optional()
});

/**
 * Retry endpoint for failed approvals
 */
approvalsRouter.post('/api/approvals/:id/retry', async (req, res) => {
  const authReq = getAuthReq(req);
  const id = req.params['id'] as string;
  const userLockKey = `${authReq.userId}:${id}:retry`;

  const parsed = RetrySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', `Invalid request body: ${parsed.error.message}`, 400);
    return;
  }
  const { proof, challengeNonce } = parsed.data;

  if (inFlightUserLocks.has(userLockKey)) {
    sendError(res, 'CONCURRENT_ACTION', 'Retry action is already in-flight.', 409, undefined, authReq.requestId);
    return;
  }

  let transitionedToExecuting = false;
  let sideEffectDone = false;
  inFlightUserLocks.add(userLockKey);

  try {
    const approval = await approvalsRepo.getById(id, authReq.userId);
    if (!approval) {
      sendError(res, 'NOT_FOUND', 'Approval record not found.', 404);
      return;
    }

    if (approval.status !== 'failed') {
      sendError(res, 'VALIDATION_FAILED', `Only failed approvals can be retried (current status is "${approval.status}").`, 400);
      return;
    }
    if (approval.execution_outcome) {
      sendError(res, 'ALREADY_EXECUTED', 'This approval already performed its action; it cannot be re-run.', 409);
      return;
    }
    if ((approval.retry_count ?? 0) >= MAX_RETRIES) {
      sendError(res, 'RETRY_LIMIT', `Retry limit (${MAX_RETRIES}) reached. Please start a new request.`, 409);
      return;
    }
    const decidedAt = approval.decided_at ? new Date(approval.decided_at).getTime() : 0;
    if (!decidedAt || Date.now() - decidedAt > 24 * 60 * 60 * 1000) {
      sendError(res, 'APPROVAL_EXPIRED', 'Retry window has expired.', 410);
      return;
    }

    // Retry ALWAYS needs a fresh step-up (no "no nonce stored, so skip" path).
    const verification = await verifyStepUp({ proof, challengeNonce }, approval, authReq.userId);
    if (!verification.ok) {
      sendError(res, verification.code, verification.message, verification.status, verification.details, authReq.requestId);
      return;
    }

    // Same atomic cap re-check as a first execution, evaluated against CURRENT caps and usage.
    await approvalsRepo.beginExecution(id, authReq.userId, ['failed']);
    transitionedToExecuting = true;

    const executionResult = await executeApprovalAction(approval, authReq.userId, authReq.requestId);
    sideEffectDone = true;
    await persistOutcome(approval.id, authReq.userId, executionResult);

    const responsePayload = { status: 'executed', result: executionResult, retried: true };
    await finalizeExecuted(approval.id, authReq.userId, executionResult, responsePayload);

    sendSuccess(res, responsePayload, authReq.requestId);
  } catch (err) {
    if (sideEffectDone) {
      logger.error('[approvals] post-execution bookkeeping failed on retry; reconciler will finish', undefined, { approvalId: id });
      sendSuccess(res, { status: 'executing', reconciling: true, retried: true }, authReq.requestId);
    } else {
      if (transitionedToExecuting) {
        await approvalsRepo.updateStatus(id, 'failed', { error: safeErrorCode(err) }, authReq.userId, undefined, ['executing']);
      }
      handleRouteError(res, err, authReq.requestId);
    }
  } finally {
    inFlightUserLocks.delete(userLockKey);
  }
});

function safeErrorCode(err: unknown): ErrorCode {
  return err instanceof AppError ? err.code : 'EXECUTION_FAILED';
}

async function persistOutcome(approvalId: string, userId: string, result: unknown): Promise<void> {
  // Agent executors persist their own outcome; only act if we are still `executing`.
  const cur = await approvalsRepo.getById(approvalId, userId);
  if (!cur || cur.status !== 'executing' || cur.execution_outcome) return;
  const outcome = (result && typeof result === 'object' ? result : { value: result }) as Record<string, unknown>;
  await approvalsRepo.updateStatus(approvalId, 'executing', undefined, userId, { execution_outcome: outcome }, ['executing']);
}

async function finalizeExecuted(
  approvalId: string,
  userId: string,
  result: unknown,
  responsePayload: Record<string, unknown>
): Promise<void> {
  const cur = await approvalsRepo.getById(approvalId, userId);
  // Already finalized by the agent executor, or the row was erased (delete_data): nothing left to write.
  if (!cur || cur.status === 'executed') return;
  const done = await approvalsRepo.updateStatus(approvalId, 'executed', result as Record<string, unknown>, userId, {
    decision_response: responsePayload
  }, ['executing']);
  if (!done) throw new Error('finalize: approval not in executing state');
}

/**
 * GDPR erasure: DB erase (erase_user) THEN delete the Supabase auth identity.
 * `erased:true` is returned only when both succeed. The approval row is deleted by erase_user, so callers must not
 * write to it afterwards; the outcome is recorded in an audit row (anonymised by erase_user) before the erase and a
 * tombstone/audit row after it.
 */
async function executeErasure(approval: Approval, userId: string, requestId: string): Promise<Record<string, unknown>> {
  await auditRepo.log({
    user_id: userId,
    request_id: requestId,
    agent: 'guardian',
    action: 'delete_data.begin',
    approval_id: approval.id,
    params: { approvalId: approval.id },
    result: { status: 'executing' }
  });

  await profilesRepo.eraseUser(userId);

  if (isRemoteSupabaseEnabled && supabaseClient) {
    const { error } = await supabaseClient.auth.admin.deleteUser(userId);
    if (error) {
      logger.error('[Erasure] Data erased but Supabase auth identity deletion FAILED; reconciler will retry', {
        userId,
        requestId,
        status: (error as { status?: number }).status,
        error: error.message
      });
      throw new UpstreamError('Account data was erased but the sign-in identity could not be removed yet. It will be retried automatically.');
    }
  }
  await erasedUsersRepo.markAuthDeleted(userId);

  // Post-erase outcome record: no user_id (the user no longer exists), approval id kept for traceability.
  await auditRepo.log({
    user_id: null,
    request_id: requestId,
    agent: 'guardian',
    action: 'delete_data.completed',
    approval_id: approval.id,
    params: { redacted: true },
    result: { erased: true }
  });
  return { erased: true };
}

async function executeApprovalAction(
  approval: Approval,
  userId: string,
  requestId: string
): Promise<unknown> {
  const user = await profilesRepo.getById(userId);
  if (!user) throw new NotFoundError('User profile not found.');

  if (approval.action_type === 'cancel_subscription') {
    return auditorAgent.executeCancellation(approval.id, userId, requestId);
  } else if (approval.action_type === 'send_requests') {
    return splitterAgent.executeSendRequests(approval.id, userId, requestId);
  } else if (approval.action_type === 'refund_group') {
    return splitterAgent.executeGroupRefund(approval.id, userId, requestId);
  } else if (approval.action_type === 'vault_move') {
    const payload = approval.payload as { action: 'lock_in' | 'roll_over'; amountMinor: number };
    // One atomic debit+credit: if anything fails nothing moves.
    const moved = await vaultRepo.moveWeeklyToVault(userId, payload.action, payload.amountMinor);
    if (!moved.ok) {
      if (moved.code === 'INSUFFICIENT') {
        throw new GuardianBlockedError(
          `Insufficient fun money balance (${moneyService.format(moved.balanceMinor ?? 0, user.currency)}) for vault move.`
        );
      }
      throw new ValidationError('Invalid vault move.');
    }
    return { vault: moved.vault, action: payload.action, amountMinor: payload.amountMinor };
  } else if (approval.action_type === 'pocket_move') {
    const payload = approval.payload as {
      fromKind: 'weekly' | 'holiday' | 'getaway';
      toKind: 'weekly' | 'holiday' | 'getaway';
      amountMinor: number;
    };
    const moved = await vaultRepo.movePocketBalance(userId, payload.fromKind, payload.toKind, payload.amountMinor);
    if (!moved.ok) {
      if (moved.code === 'INSUFFICIENT') throw new GuardianBlockedError('Insufficient balance in source pocket.');
      throw new ValidationError('Invalid pocket move.');
    }
    return { moved: true, from: payload.fromKind, to: payload.toKind, amountMinor: payload.amountMinor };
  } else if (approval.action_type === 'reset_learning') {
    await banditRepo.resetAllForUser(userId);
    return { reset: true };
  } else if (approval.action_type === 'delete_data') {
    return executeErasure(approval, userId, requestId);
  } else if (approval.action_type === 'change_currency') {
    // Re-validate at execution time and convert from the CURRENT profile, never from stale payload numbers.
    const payload = approval.payload as { from?: string; to?: string };
    if (!payload.to || !payload.from || payload.from !== user.currency || !isSupportedCurrency(payload.to)) {
      throw new ValidationError('Currency changed since this request was made. Please start again.');
    }
    await assertCurrencyChangeAllowed(user);
    const targetCurrency = payload.to;
    const convert = (n: number) => moneyService.convertMinorPreservingMajor(n, user.currency, targetCurrency);
    await profilesRepo.upsert({
      ...user,
      currency: targetCurrency,
      per_action_cap_minor: convert(user.per_action_cap_minor),
      weekly_cap_minor: convert(user.weekly_cap_minor),
      guilt_free_cap_minor: convert(user.guilt_free_cap_minor)
    });
    return { currency: targetCurrency };
  } else if (approval.action_type === 'change_caps') {
    const payload = approval.payload as { per_action_cap_minor?: number; weekly_cap_minor?: number };
    await profilesRepo.upsert({
      ...user,
      per_action_cap_minor: payload.per_action_cap_minor ?? user.per_action_cap_minor,
      weekly_cap_minor: payload.weekly_cap_minor ?? user.weekly_cap_minor
    });
    return { capsUpdated: true, newCaps: payload };
  } else {
    throw new ValidationError(`Unknown or unhandled approval action type: ${approval.action_type}`);
  }
}
