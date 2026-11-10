import { ApiError } from './api';
import { toast } from './toast';

/**
 * One place that turns an API failure into something a person can act on. Every server ErrorCode has an entry
 * (a test compares this table with the API's ErrorCode union, so a new server code cannot ship without a message).
 * `server: true` means the server's own message is specific and safe to show (e.g. which field is wrong).
 */
interface Entry {
  message: string;
  server?: boolean;
  retryable?: boolean;
  signOut?: boolean;
}

export const ERROR_TABLE = {
  VALIDATION_FAILED: { message: 'Please check the details and try again.', server: true },
  UNAUTHENTICATED: { message: 'Your session has ended. Please sign in again.', signOut: true },
  FORBIDDEN: { message: 'You are not allowed to do that.' },
  NOT_FOUND: { message: 'We could not find that. It may have been removed.' },
  CONFLICT: { message: 'That conflicts with the current state. Refresh and try again.', server: true },
  GUARDIAN_BLOCKED: { message: 'A spending safeguard blocked this action.', server: true },
  APPROVAL_REQUIRED: { message: 'This needs your approval first.' },
  APPROVAL_EXPIRED: { message: 'This approval has expired. Start it again to get a fresh one.' },
  IDEMPOTENT_REPLAY: { message: 'That was already submitted.' },
  CONCURRENT_ACTION: { message: 'Another action is still in progress. Give it a moment, then try again.', retryable: true },
  ALREADY_REFUNDED: { message: 'This has already been refunded.' },
  OUTING_CANCELLED: { message: 'This outing was cancelled.' },
  OUTING_EXPIRED: { message: 'This outing has expired.' },
  UPSTREAM_PAYPAL: { message: 'PayPal is not responding right now. Please try again shortly.', retryable: true },
  UPSTREAM_LLM: { message: 'The assistant is unavailable right now. Please try again shortly.', retryable: true },
  RATE_LIMITED: { message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
  ACCOUNT_ERASED: { message: 'This account has been permanently erased.', signOut: true },
  STEP_UP_NOT_ENROLLED: { message: 'Set up a passkey, authenticator app or PIN first.' },
  STEP_UP_REQUIRED: { message: 'Verification is required to continue.' },
  STEP_UP_CHALLENGE_REQUIRED: { message: 'That verification expired. Please try again.', retryable: true },
  STEP_UP_CHALLENGE_EXPIRED: { message: 'That verification expired. Please try again.', retryable: true },
  STEP_UP_CHALLENGE_INVALID: { message: 'That verification no longer matches this request. Please try again.', retryable: true },
  STEP_UP_LOCKED: { message: 'Too many incorrect attempts. PIN and authenticator codes are locked for 15 minutes; a passkey still works.' },
  STEP_UP_FAILED: { message: 'Verification failed. Please try again.', server: true, retryable: true },
  STEP_UP_COOLDOWN: { message: 'A verification method was recently added or changed, so it cannot approve money actions yet. Check Approval security on the You screen for the time left.', server: false },
  FRESH_SESSION_REQUIRED: { message: 'Please sign in again, then set up your first verification method right away.' },
  REGION_REQUIRED: { message: 'Set your region to see local holidays and plan getaways.' },
  ALREADY_EXECUTED: { message: 'This already happened and cannot be run again.' },
  RETRY_LIMIT: { message: 'This has been retried too many times. Please start a new request.' },
  EXECUTION_FAILED: { message: 'The action did not complete. You can try again.', retryable: true },
  INTERNAL_ERROR: { message: 'Something went wrong on our side. Please try again.', retryable: true }
} as const satisfies Record<string, Entry>;

/** Codes raised in the browser, never by the server. */
const CLIENT_TABLE: Record<string, Entry & { silent?: boolean }> = {
  STEP_UP_CANCELLED: { message: 'Cancelled.', silent: true },
  STEP_UP_UNAVAILABLE: { message: 'Verification is unavailable right now. Please reload and try again.' },
  NETWORK_ERROR: { message: 'We could not reach the server. Check your connection and try again.', retryable: true },
  REQUEST_TIMEOUT: { message: 'That took too long. Please try again.', retryable: true },
  API_ERROR: { message: 'Something went wrong. Please try again.', retryable: true }
};

export interface DescribedError {
  code: string;
  message: string;
  /** The user dismissed something themselves (e.g. closed the passkey dialog): do not show an error. */
  silent: boolean;
  retryable: boolean;
  signOut: boolean;
}

export function describeApiError(err: unknown): DescribedError {
  const code = err instanceof ApiError ? err.code : 'API_ERROR';
  const serverMessage = err instanceof Error ? err.message.trim() : '';
  const client = CLIENT_TABLE[code];
  if (client) {
    return { code, message: client.message, silent: !!client.silent, retryable: !!client.retryable, signOut: false };
  }
  const entry: Entry | undefined = (ERROR_TABLE as Record<string, Entry>)[code];
  if (!entry) {
    // A code this build does not know (newer server): never show a raw code; use the server's words if any.
    return { code, message: serverMessage || CLIENT_TABLE['API_ERROR']!.message, silent: false, retryable: false, signOut: false };
  }
  return {
    code,
    message: entry.server && serverMessage ? serverMessage : entry.message,
    silent: false,
    retryable: !!entry.retryable,
    signOut: !!entry.signOut
  };
}

/** Toasts a human-readable failure (nothing for a user-initiated cancel). Returns the description for callers that branch on it. */
export function notifyError(err: unknown, context?: string): DescribedError {
  const d = describeApiError(err);
  if (!d.silent) toast.error(context ? `${context}: ${d.message}` : d.message);
  return d;
}
