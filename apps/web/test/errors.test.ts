import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../src/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
import { ERROR_TABLE, describeApiError, notifyError } from '../src/lib/errors';
import { ApiError } from '../src/lib/api';
import { toast } from '../src/lib/toast';

/** E3: every error the API can send has a human message in the web app. */
const apiCodes = (): string[] => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../api/src/core/errors.ts'), 'utf-8');
  const block = src.slice(src.indexOf('export type ErrorCode ='), src.indexOf('export class AppError'));
  return [...block.matchAll(/\|\s*'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
};

describe('E3: API error codes', () => {
  it('the web table covers every ErrorCode the API can send, and has no stale ones', () => {
    expect(Object.keys(ERROR_TABLE).sort()).toEqual(apiCodes());
  });

  it('every code resolves to a non-empty, code-free sentence', () => {
    for (const code of apiCodes()) {
      const d = describeApiError(new ApiError('', 400, code));
      expect(d.message.length, code).toBeGreaterThan(10);
      expect(d.message, code).not.toMatch(/[A-Z]{3,}_[A-Z_]+/); // never a raw SCREAMING_CODE
      expect(d.message, code).not.toMatch(/undefined|null|\[object/);
    }
  });

  it('uses the server message only where it is specific and safe (validation, guardian, step-up failure)', () => {
    expect(describeApiError(new ApiError('Total must be positive', 400, 'VALIDATION_FAILED')).message).toBe('Total must be positive');
    expect(describeApiError(new ApiError('Incorrect PIN.', 403, 'STEP_UP_FAILED')).message).toBe('Incorrect PIN.');
    // INTERNAL_ERROR text is ours even if the server text were odd
    expect(describeApiError(new ApiError('stack trace at line 5', 500, 'INTERNAL_ERROR')).message).not.toContain('stack');
  });

  it('falls back to our own wording when the server message is empty', () => {
    expect(describeApiError(new ApiError('', 400, 'VALIDATION_FAILED')).message).toBe(ERROR_TABLE.VALIDATION_FAILED.message);
  });

  it('flags retryable failures and sign-out failures', () => {
    expect(describeApiError(new ApiError('x', 409, 'CONCURRENT_ACTION')).retryable).toBe(true);
    expect(describeApiError(new ApiError('x', 502, 'UPSTREAM_PAYPAL')).retryable).toBe(true);
    expect(describeApiError(new ApiError('x', 409, 'RETRY_LIMIT')).retryable).toBe(false);
    expect(describeApiError(new ApiError('x', 409, 'ALREADY_EXECUTED')).retryable).toBe(false);
    expect(describeApiError(new ApiError('x', 401, 'ACCOUNT_ERASED')).signOut).toBe(true);
    expect(describeApiError(new ApiError('x', 401, 'UNAUTHENTICATED')).signOut).toBe(true);
    expect(describeApiError(new ApiError('x', 403, 'STEP_UP_FAILED')).signOut).toBe(false);
  });

  it('explains a lockout without suggesting the user is stuck (passkeys still work)', () => {
    const m = describeApiError(new ApiError('x', 403, 'STEP_UP_LOCKED')).message;
    expect(m).toMatch(/locked/i);
    expect(m).toMatch(/passkey/i);
  });

  it('a unknown future code never leaks the raw code', () => {
    const d = describeApiError(new ApiError('Try again later', 500, 'BRAND_NEW_SERVER_CODE'));
    expect(d.message).toBe('Try again later');
    expect(describeApiError(new ApiError('', 500, 'BRAND_NEW_SERVER_CODE')).message).not.toContain('BRAND_NEW');
  });

  it('handles non-ApiError values', () => {
    expect(describeApiError(new Error('boom')).code).toBe('API_ERROR');
    expect(describeApiError('weird').message.length).toBeGreaterThan(5);
    expect(describeApiError(undefined).silent).toBe(false);
  });

  describe('notifyError', () => {
    it('shows a toast with context', () => {
      notifyError(new ApiError('', 502, 'UPSTREAM_PAYPAL'), 'Approval did not complete');
      expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith(expect.stringMatching(/^Approval did not complete: PayPal is not responding/));
    });
    it('stays silent when the user cancelled the verification themselves', () => {
      vi.mocked(toast.error).mockClear();
      const d = notifyError(new ApiError('Approval cancelled.', 0, 'STEP_UP_CANCELLED'));
      expect(d.silent).toBe(true);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});
