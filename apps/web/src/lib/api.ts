import { sessionStore } from './sessionStore';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';

const rawApiUrl = (import.meta.env['VITE_API_URL'] as string) || 'http://localhost:3001';
const API_BASE = rawApiUrl.startsWith('http://') || rawApiUrl.startsWith('https://')
  ? rawApiUrl
  : `https://${rawApiUrl}`;

export interface ApiResponse<T> {
  ok: boolean;
  data: T;
  requestId?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(message: string, status: number, code = 'API_ERROR', details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  idempotencyKey?: string
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  // Attach the session token (getToken() drops it if expired)
  if (!headers.has('Authorization')) {
    const token = sessionStore.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  // Idempotency key for money actions
  const effectiveIdempotencyKey =
    idempotencyKey ||
    (endpoint.includes('/decide')
      ? `auto_seal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      : undefined);

  if (effectiveIdempotencyKey && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', effectiveIdempotencyKey);
  }

  // 15-second AbortController timeout guard
  const timeoutMs = 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort());
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ApiError('Request timed out after 15 seconds. Please try again.', 408, 'REQUEST_TIMEOUT');
    }
    throw new ApiError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 0, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 401) {
    sessionStore.clear();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pocketful:unauthorized'));
    }
  }

  let json: ApiResponse<T>;
  try {
    json = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(
      `Server returned invalid response (HTTP ${res.status})`,
      res.status,
      'INVALID_RESPONSE'
    );
  }

  if (!res.ok || !json.ok) {
    const errorMsg = json.error?.message || `Request failed with HTTP status ${res.status}`;
    const code = json.error?.code || 'API_ERROR';
    throw new ApiError(errorMsg, res.status, code, json.error?.details, json.requestId);
  }

  return json.data;
}

// ---------------------------------------------------------------------------------------------------------
// Step-up (approving anything that moves money or deletes data)
//
// A stolen session token alone must never be enough. The server issues a single-use challenge bound to the exact
// approval; the user proves it with a real factor: a passkey (primary; the authenticator signs the challenge),
// an authenticator-app code, or the PIN. Nothing here is derived from data the server returns.
// ---------------------------------------------------------------------------------------------------------

export type StepUpMethod = 'passkey' | 'totp' | 'pin';

export type StepUpProof =
  | { method: 'passkey'; assertion: unknown }
  | { method: 'totp'; code: string }
  | { method: 'pin'; pin: string };

/** Spread straight into the body of POST /api/approvals/:id/decide and /retry. */
export interface StepUpInput {
  proof: StepUpProof;
  challengeNonce: string;
}

export type StepUpPromptRequest =
  | { mode: 'enroll'; passkeySupported: boolean }
  | { mode: 'verify'; methods: StepUpMethod[]; passkeySupported: boolean };

/** What the user chose. `passkey` carries no secret: the browser runs the WebAuthn ceremony afterwards. */
export type StepUpPromptResult =
  | { method: 'passkey' }
  | { method: 'totp'; code: string }
  | { method: 'pin'; pin: string };

export type StepUpPrompter = (req: StepUpPromptRequest) => Promise<StepUpPromptResult | null>;

export interface StepUpStatus {
  enrolled: boolean;
  methods: string[];
  passkeys: number;
  totp: boolean;
  pin: boolean;
  lockedUntil: string | null;
  /** Seconds until a newly added/changed method may approve money actions (0 = none running). */
  cooldownRemainingSeconds?: number;
}

export interface SecurityNotification {
  id: string;
  kind: 'factor_enrolled' | 'factor_replaced' | 'factor_removed';
  factor: 'pin' | 'totp' | 'passkey';
  message: string;
  created_at: string;
}

interface StepUpChallenge {
  challengeNonce: string;
  methods: string[];
  passkeyOptions?: PublicKeyCredentialRequestOptionsJSON;
}

let stepUpPrompter: StepUpPrompter | null = null;

/** Registered once by <StepUpPromptHost/>. Approvals need a real user gesture. */
export function registerStepUpPrompter(fn: StepUpPrompter | null): void {
  stepUpPrompter = fn;
}

const cancelled = () => new ApiError('Approval cancelled.', 0, 'STEP_UP_CANCELLED');

function needPrompter(): StepUpPrompter {
  if (!stepUpPrompter) throw new ApiError('Verification prompt unavailable.', 0, 'STEP_UP_UNAVAILABLE');
  return stepUpPrompter;
}

const realMethods = (methods: string[]): StepUpMethod[] =>
  methods.filter((m): m is StepUpMethod => m === 'passkey' || m === 'totp' || m === 'pin');

/** Maps a failed WebAuthn ceremony to an ApiError. A dismissed browser dialog is a cancel, not a failure. */
function webauthnError(err: unknown): ApiError {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return cancelled();
  return new ApiError(
    'Your device could not complete the passkey step. You can use another method.',
    0,
    'STEP_UP_FAILED'
  );
}

async function collectProof(
  prompter: StepUpPrompter,
  methods: string[],
  passkeyOptions: PublicKeyCredentialRequestOptionsJSON | undefined
): Promise<StepUpProof> {
  const usable = realMethods(methods);
  const choice = await prompter({ mode: 'verify', methods: usable, passkeySupported: browserSupportsWebAuthn() });
  if (!choice) throw cancelled();
  if (choice.method === 'passkey') {
    if (!passkeyOptions) throw new ApiError('No passkey is registered for this account.', 0, 'STEP_UP_FAILED');
    try {
      return { method: 'passkey', assertion: await startAuthentication({ optionsJSON: passkeyOptions }) };
    } catch (err) {
      throw webauthnError(err);
    }
  }
  return choice;
}

/** Runs the WebAuthn registration ceremony. `proof` is required once any factor already exists. */
export async function registerPasskey(proof?: StepUpProof, label?: string): Promise<void> {
  const { options } = await apiFetch<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    '/api/auth/passkeys/register/options',
    { method: 'POST', body: JSON.stringify(proof ? { proof } : {}) }
  );
  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON: options });
  } catch (err) {
    throw webauthnError(err);
  }
  await apiFetch('/api/auth/passkeys/register/verify', {
    method: 'POST',
    body: JSON.stringify({ attestation, ...(label ? { label } : {}) })
  });
}

async function enrollFirstFactor(prompter: StepUpPrompter): Promise<void> {
  const choice = await prompter({ mode: 'enroll', passkeySupported: browserSupportsWebAuthn() });
  if (!choice) throw cancelled();
  if (choice.method === 'passkey') {
    await registerPasskey();
  } else if (choice.method === 'pin') {
    await apiFetch('/api/auth/step-up/pin', { method: 'PUT', body: JSON.stringify({ pin: choice.pin }) });
  } else {
    throw new ApiError('Set up an authenticator app from the You screen.', 0, 'STEP_UP_UNAVAILABLE');
  }
}

/**
 * Collects a step-up proof for one approval: enrols a first factor if the user has none, requests the
 * single-use challenge, and asks the user to prove it.
 */
export async function obtainStepUp(approvalId: string): Promise<StepUpInput> {
  const prompter = needPrompter();
  const status = await apiFetch<StepUpStatus>('/api/auth/step-up');
  if (!status.enrolled) await enrollFirstFactor(prompter);
  const challenge = await apiFetch<StepUpChallenge>(`/api/approvals/${approvalId}/challenge`, { method: 'POST' });
  const proof = await collectProof(prompter, challenge.methods, challenge.passkeyOptions);
  return { proof, challengeNonce: challenge.challengeNonce };
}

/**
 * Proof from an EXISTING factor, required before adding or changing any factor (so a stolen session cannot quietly
 * add its own). Returns undefined when the user has no factor yet (the first one needs only the session).
 */
export async function proveExistingFactor(): Promise<StepUpProof | undefined> {
  const prompter = needPrompter();
  const status = await apiFetch<StepUpStatus>('/api/auth/step-up');
  if (!status.enrolled) return undefined;
  const c = await apiFetch<Omit<StepUpChallenge, 'challengeNonce'>>('/api/auth/step-up/challenge', { method: 'POST' });
  return collectProof(prompter, c.methods, c.passkeyOptions);
}

export async function getStepUpStatus(): Promise<StepUpStatus> {
  return apiFetch<StepUpStatus>('/api/auth/step-up');
}

/** Changes to the user's verification methods (added / changed / removed), newest first. */
export async function getSecurityNotifications(): Promise<SecurityNotification[]> {
  const res = await apiFetch<{ notifications: SecurityNotification[] }>('/api/auth/security-notifications');
  return res.notifications;
}

/** Removing a method needs proof from an existing one (the server enforces it, including for the last method). */
export async function removeFactor(kind: 'pin' | 'totp'): Promise<void> {
  const proof = await proveExistingFactor();
  await apiFetch(`/api/auth/step-up/${kind}`, { method: 'DELETE', body: JSON.stringify(proof ? { proof } : {}) });
}

export async function addPasskey(): Promise<void> {
  await registerPasskey(await proveExistingFactor(), 'This device');
}

export async function changePin(newPin: string): Promise<void> {
  const proof = await proveExistingFactor();
  await apiFetch('/api/auth/step-up/pin', { method: 'PUT', body: JSON.stringify({ pin: newPin, ...(proof ? { proof } : {}) }) });
}

/** Starts authenticator-app setup. The secret is shown once; confirm with confirmTotp(). */
export async function beginTotpSetup(): Promise<{ secret: string; otpauthUri: string }> {
  const proof = await proveExistingFactor();
  return apiFetch('/api/auth/step-up/totp/enroll', { method: 'POST', body: JSON.stringify(proof ? { proof } : {}) });
}

export async function confirmTotp(code: string): Promise<void> {
  await apiFetch('/api/auth/step-up/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) });
}

export interface GroupSplitPreview {
  totalMinor: number;
  currency: string;
  /** In the order friends were submitted. */
  friendShares: number[];
  organizerShareMinor: number;
}

/**
 * The exact equal-split amounts the server will stage for this bill. The UI must show these and never compute its
 * own split: the remainder pennies are assigned server-side, so a local calculation can disagree with what friends
 * are actually asked to pay.
 */
export async function previewGroupSplit(totalMinor: number, friendCount: number, signal?: AbortSignal): Promise<GroupSplitPreview> {
  return apiFetch<GroupSplitPreview>('/api/groups/preview', {
    method: 'POST',
    body: JSON.stringify({ totalMinor, friendCount }),
    ...(signal ? { signal } : {})
  });
}

export interface SealResult {
  status: string;
  result?: unknown;
  /** The action happened but the server is still recording it. Show success, not an error. */
  reconciling?: boolean;
  /** Nothing was run: the approval had already been executed. */
  alreadyDone?: boolean;
}

/**
 * Seals (approves) one pending approval end to end, and is safe to call again after a failure:
 *  - reads the approval first, so we never ask for verification when there is nothing to do;
 *  - `failed` approvals go through /retry (fresh verification, server re-checks caps, max 3 attempts), because
 *    re-sending the original decision would only replay the stored failure;
 *  - an already `executed` approval is reported as done, `executing` as in progress.
 */
export async function sealApproval(approvalId: string, idempotencyKey: string): Promise<SealResult> {
  const { approval } = await apiFetch<{ approval: { status: string } }>(`/api/approvals/${approvalId}`);
  switch (approval.status) {
    case 'executed':
      return { status: 'executed', alreadyDone: true };
    case 'executing':
      throw new ApiError('This action is already being processed.', 409, 'CONCURRENT_ACTION');
    case 'expired':
      throw new ApiError('This approval has expired.', 410, 'APPROVAL_EXPIRED');
    case 'denied':
    case 'cancelled':
      throw new ApiError(`This approval was ${approval.status}.`, 409, 'CONFLICT');
  }
  const stepUp = await obtainStepUp(approvalId);
  if (approval.status === 'failed') {
    return apiFetch<SealResult>(`/api/approvals/${approvalId}/retry`, { method: 'POST', body: JSON.stringify(stepUp) });
  }
  return apiFetch<SealResult>(
    `/api/approvals/${approvalId}/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve', ...stepUp }) },
    idempotencyKey
  );
}
