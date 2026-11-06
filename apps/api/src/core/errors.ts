import type { Response } from 'express';
import { logger } from './logger.js';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GUARDIAN_BLOCKED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_EXPIRED'
  | 'IDEMPOTENT_REPLAY'
  | 'CONCURRENT_ACTION'
  | 'ALREADY_REFUNDED'
  | 'OUTING_CANCELLED'
  | 'OUTING_EXPIRED'
  | 'UPSTREAM_PAYPAL'
  | 'UPSTREAM_LLM'
  | 'RATE_LIMITED'
  | 'ACCOUNT_ERASED'
  | 'STEP_UP_NOT_ENROLLED'
  | 'STEP_UP_REQUIRED'
  | 'STEP_UP_CHALLENGE_REQUIRED'
  | 'STEP_UP_CHALLENGE_EXPIRED'
  | 'STEP_UP_CHALLENGE_INVALID'
  | 'STEP_UP_LOCKED'
  | 'STEP_UP_FAILED'
  | 'STEP_UP_COOLDOWN'
  | 'FRESH_SESSION_REQUIRED'
  | 'REGION_REQUIRED'
  | 'ALREADY_EXECUTED'
  | 'RETRY_LIMIT'
  | 'EXECUTION_FAILED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_FAILED', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
    this.name = 'AuthenticationError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict detected') {
    super('CONFLICT', message, 409);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again later.') {
    super('RATE_LIMITED', message, 429);
    this.name = 'RateLimitError';
  }
}

export class GuardianBlockedError extends AppError {
  constructor(message = 'Action blocked by Guardian safety policy.', details?: unknown) {
    super('GUARDIAN_BLOCKED', message, 422, details);
    this.name = 'GuardianBlockedError';
  }
}

export class ApprovalExpiredError extends AppError {
  constructor(message = 'Approval window has expired. A fresh approval must be staged.', details?: unknown) {
    super('APPROVAL_EXPIRED', message, 410, details);
    this.name = 'ApprovalExpiredError';
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = 'An in-flight or conflicting request is already being processed.', details?: unknown) {
    super('IDEMPOTENT_REPLAY', message, 409, details);
    this.name = 'IdempotencyConflictError';
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'Upstream service error', details?: unknown) {
    super('INTERNAL_ERROR', message, 502, details);
    this.name = 'UpstreamError';
  }
}

export interface ApiErrorResponse {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function sendSuccess<T>(res: Response, data: T, requestId?: string, status = 200): void {
  res.status(status).json({
    ok: true,
    data,
    requestId
  });
}

export function sendError(
  res: Response,
  code: ErrorCode,
  message: string,
  statusCode = 400,
  details?: unknown,
  requestId?: string
): void {
  const payload: ApiErrorResponse = {
    ok: false,
    error: {
      code,
      message,
      details,
      requestId
    }
  };
  res.status(statusCode).json(payload);
}

const SECRET_RE = /(bearer\s+[a-z0-9._~+/=-]+|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]*|(?:secret|token|password|api[_-]?key|authorization|access_token)["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s"',}]+)/gi;

/** Truncate (max 500 chars) and redact token-like substrings for logging upstream bodies. */
export function redactForLog(v: unknown, max = 500): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : v instanceof Error ? v.message : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return (s ?? '').replace(SECRET_RE, '[redacted]').slice(0, max);
}

/**
 * Safe, storable summary of an error: a code and a short message that cannot leak internals.
 * Used for approval `result` and any persisted/returned error field (never String(err)).
 */
export function safeErrorSummary(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof UpstreamError) return { code: 'INTERNAL_ERROR', message: 'An upstream service failed.' };
  if (err instanceof AppError) return { code: err.code, message: err.message.slice(0, 200) };
  return { code: 'INTERNAL_ERROR', message: 'Execution failed.' };
}

export function handleRouteError(res: Response, err: unknown, requestId?: string): void {
  if (err instanceof UpstreamError) {
    // Full detail (truncated + redacted) goes to the server log only.
    logger.error('UpstreamError', undefined, { requestId, detail: redactForLog(err.message), upstream: redactForLog(err.details) });
    sendError(res, 'INTERNAL_ERROR', 'An upstream service is unavailable. Please try again.', 502, undefined, requestId);
    return;
  }
  if (err instanceof AppError) {
    sendError(res, err.code, err.message, err.statusCode, err.details, requestId);
    return;
  }

  if (err instanceof ZodError) {
    sendError(
      res,
      'VALIDATION_FAILED',
      'Input validation failed',
      400,
      err.issues.map((e) => ({ path: e.path.map(String).join('.'), message: e.message })),
      requestId
    );
    return;
  }

  logger.error('Unhandled error', undefined, { requestId, detail: redactForLog(err), stack: err instanceof Error ? redactForLog(err.stack, 1500) : undefined });
  sendError(res, 'INTERNAL_ERROR', 'Something went wrong.', 500, undefined, requestId);
}
