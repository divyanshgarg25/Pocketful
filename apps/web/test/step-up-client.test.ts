import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true)
}));
vi.mock('@simplewebauthn/browser', () => webauthn);

import {
  ApiError,
  addPasskey,
  beginTotpSetup,
  changePin,
  obtainStepUp,
  proveExistingFactor,
  registerStepUpPrompter,
  type StepUpPromptRequest,
  type StepUpPromptResult
} from '../src/lib/api';

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let routes: Record<string, (body: unknown) => unknown>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: status < 400, data }), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  routes = {};
  webauthn.startAuthentication.mockReset();
  webauthn.startRegistration.mockReset();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      const handler = routes[`${method} ${path}`];
      if (!handler) return json({ message: `unrouted ${method} ${path}` }, 500);
      return json(handler(body));
    })
  );
});
afterEach(() => {
  registerStepUpPrompter(null);
  vi.unstubAllGlobals();
});

const prompt = (answer: StepUpPromptResult | null) => {
  const seen: StepUpPromptRequest[] = [];
  registerStepUpPrompter(async (req) => {
    seen.push(req);
    return answer;
  });
  return seen;
};
const enrolledStatus = { enrolled: true, methods: ['pin'], passkeys: 0, totp: false, pin: true, lockedUntil: null };
const challengeRoute = (extra: Record<string, unknown> = {}) => () => ({ challengeNonce: 'nonce-1', methods: ['pin'], ...extra });

describe('obtainStepUp', () => {
  it('returns a PIN proof bound to the server challenge nonce', async () => {
    routes['GET /api/auth/step-up'] = () => enrolledStatus;
    routes['POST /api/approvals/a1/challenge'] = challengeRoute();
    const seen = prompt({ method: 'pin', pin: '482916' });
    const out = await obtainStepUp('a1');
    expect(out).toEqual({ proof: { method: 'pin', pin: '482916' }, challengeNonce: 'nonce-1' });
    expect(seen[0]).toMatchObject({ mode: 'verify', methods: ['pin'] });
  });

  it('runs the WebAuthn ceremony with the options the server issued and returns the assertion', async () => {
    const passkeyOptions = { challenge: 'abc', rpId: 'localhost' };
    routes['GET /api/auth/step-up'] = () => ({ ...enrolledStatus, methods: ['passkey'], passkeys: 1, pin: false });
    routes['POST /api/approvals/a1/challenge'] = challengeRoute({ methods: ['passkey'], passkeyOptions });
    webauthn.startAuthentication.mockResolvedValue({ id: 'cred', response: {} });
    prompt({ method: 'passkey' });
    const out = await obtainStepUp('a1');
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: passkeyOptions });
    expect(out.proof).toEqual({ method: 'passkey', assertion: { id: 'cred', response: {} } });
  });

  it('treats a dismissed passkey dialog as a cancel, not a failure', async () => {
    routes['GET /api/auth/step-up'] = () => ({ ...enrolledStatus, passkeys: 1 });
    routes['POST /api/approvals/a1/challenge'] = challengeRoute({ methods: ['passkey'], passkeyOptions: { challenge: 'x' } });
    webauthn.startAuthentication.mockRejectedValue(Object.assign(new Error('dismissed'), { name: 'NotAllowedError' }));
    prompt({ method: 'passkey' });
    await expect(obtainStepUp('a1')).rejects.toMatchObject({ code: 'STEP_UP_CANCELLED' });
  });

  it('reports other WebAuthn errors as a failure without leaking the raw message', async () => {
    routes['GET /api/auth/step-up'] = () => enrolledStatus;
    routes['POST /api/approvals/a1/challenge'] = challengeRoute({ passkeyOptions: { challenge: 'x' } });
    webauthn.startAuthentication.mockRejectedValue(new Error('internal authenticator detail 0xDEADBEEF'));
    prompt({ method: 'passkey' });
    const err = await obtainStepUp('a1').catch((e) => e as ApiError);
    expect(err).toMatchObject({ code: 'STEP_UP_FAILED' });
    expect((err as ApiError).message).not.toContain('0xDEADBEEF');
  });

  it('fails cleanly if a passkey is chosen but the server issued no passkey options', async () => {
    routes['GET /api/auth/step-up'] = () => enrolledStatus;
    routes['POST /api/approvals/a1/challenge'] = challengeRoute();
    prompt({ method: 'passkey' });
    await expect(obtainStepUp('a1')).rejects.toMatchObject({ code: 'STEP_UP_FAILED' });
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it('cancelling the prompt cancels the approval', async () => {
    routes['GET /api/auth/step-up'] = () => enrolledStatus;
    routes['POST /api/approvals/a1/challenge'] = challengeRoute();
    prompt(null);
    await expect(obtainStepUp('a1')).rejects.toMatchObject({ code: 'STEP_UP_CANCELLED' });
  });

  it('passes a TOTP code through', async () => {
    routes['GET /api/auth/step-up'] = () => ({ ...enrolledStatus, totp: true, methods: ['totp'] });
    routes['POST /api/approvals/a1/challenge'] = challengeRoute({ methods: ['totp'] });
    prompt({ method: 'totp', code: '123456' });
    expect((await obtainStepUp('a1')).proof).toEqual({ method: 'totp', code: '123456' });
  });

  it('never offers the server-side test authenticator to the user', async () => {
    routes['GET /api/auth/step-up'] = () => enrolledStatus;
    routes['POST /api/approvals/a1/challenge'] = challengeRoute({ methods: ['pin', 'test'] });
    const seen = prompt({ method: 'pin', pin: '482916' });
    await obtainStepUp('a1');
    expect((seen[0] as { methods: string[] }).methods).toEqual(['pin']);
  });

  it('enrols a first PIN BEFORE requesting the challenge', async () => {
    routes['GET /api/auth/step-up'] = () => ({ ...enrolledStatus, enrolled: false, pin: false, methods: [] });
    routes['PUT /api/auth/step-up/pin'] = () => ({ enrolled: true });
    routes['POST /api/approvals/a1/challenge'] = challengeRoute();
    let n = 0;
    registerStepUpPrompter(async (req) => (req.mode === 'enroll' ? { method: 'pin', pin: '482916' } : (n++, { method: 'pin', pin: '482916' })));
    await obtainStepUp('a1');
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('PUT /api/auth/step-up/pin')).toBeLessThan(order.indexOf('POST /api/approvals/a1/challenge'));
    expect(calls.find((c) => c.path === '/api/auth/step-up/pin')?.body).toEqual({ pin: '482916' });
    expect(n).toBe(1);
  });

  it('enrols a first passkey through the register ceremony', async () => {
    routes['GET /api/auth/step-up'] = () => ({ ...enrolledStatus, enrolled: false, pin: false, methods: [] });
    routes['POST /api/auth/passkeys/register/options'] = () => ({ options: { challenge: 'reg' } });
    routes['POST /api/auth/passkeys/register/verify'] = () => ({ registered: true });
    routes['POST /api/approvals/a1/challenge'] = challengeRoute({ methods: ['passkey'], passkeyOptions: { challenge: 'x' } });
    webauthn.startRegistration.mockResolvedValue({ id: 'new-cred' });
    webauthn.startAuthentication.mockResolvedValue({ id: 'new-cred', sig: 1 });
    registerStepUpPrompter(async () => ({ method: 'passkey' }));
    const out = await obtainStepUp('a1');
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'reg' } });
    expect(calls.find((c) => c.path === '/api/auth/passkeys/register/verify')?.body).toMatchObject({ attestation: { id: 'new-cred' } });
    expect(out.proof.method).toBe('passkey');
  });

  it('a dismissed registration dialog cancels without calling the verify endpoint', async () => {
    routes['GET /api/auth/step-up'] = () => ({ ...enrolledStatus, enrolled: false, methods: [] });
    routes['POST /api/auth/passkeys/register/options'] = () => ({ options: { challenge: 'reg' } });
    webauthn.startRegistration.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    registerStepUpPrompter(async () => ({ method: 'passkey' }));
    await expect(obtainStepUp('a1')).rejects.toMatchObject({ code: 'STEP_UP_CANCELLED' });
    expect(calls.some((c) => c.path.endsWith('/register/verify'))).toBe(false);
  });

  it('tells the prompter whether this browser supports passkeys', async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    routes['GET /api/auth/step-up'] = () => enrolledStatus;
    routes['POST /api/approvals/a1/challenge'] = challengeRoute();
    const seen = prompt({ method: 'pin', pin: '482916' });
    await obtainStepUp('a1');
    expect(seen[0]).toMatchObject({ passkeySupported: false });
  });

  it('throws a clear error if no prompter is mounted', async () => {
    await expect(obtainStepUp('a1')).rejects.toMatchObject({ code: 'STEP_UP_UNAVAILABLE' });
  });
});

describe('factor changes require proof from an existing factor', () => {
  it('proveExistingFactor is undefined for a brand-new user (first factor needs only the session)', async () => {
    routes['GET /api/auth/step-up'] = () => ({ ...enrolledStatus, enrolled: false, methods: [] });
    registerStepUpPrompter(async () => ({ method: 'pin', pin: '1' }));
    expect(await proveExistingFactor()).toBeUndefined();
    expect(calls.some((c) => c.path === '/api/auth/step-up/challenge')).toBe(false);
  });

  it('changePin sends the existing-factor proof along with the new PIN', async () => {
    routes['GET /api/auth/step-up'] = () => enrolledStatus;
    routes['POST /api/auth/step-up/challenge'] = () => ({ methods: ['pin'] });
    routes['PUT /api/auth/step-up/pin'] = () => ({ enrolled: true });
    prompt({ method: 'pin', pin: '482916' });
    await changePin('739158');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ pin: '739158', proof: { method: 'pin', pin: '482916' } });
  });

  it('addPasskey for a passkey-only user proves with a passkey over the enrol challenge', async () => {
    routes['GET /api/auth/step-up'] = () => ({ ...enrolledStatus, passkeys: 1, pin: false, methods: ['passkey'] });
    routes['POST /api/auth/step-up/challenge'] = () => ({ methods: ['passkey'], passkeyOptions: { challenge: 'enroll-ch' } });
    routes['POST /api/auth/passkeys/register/options'] = () => ({ options: { challenge: 'reg' } });
    routes['POST /api/auth/passkeys/register/verify'] = () => ({ registered: true });
    webauthn.startAuthentication.mockResolvedValue({ id: 'old' });
    webauthn.startRegistration.mockResolvedValue({ id: 'new' });
    prompt({ method: 'passkey' });
    await addPasskey();
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'enroll-ch' } });
    expect(calls.find((c) => c.path === '/api/auth/passkeys/register/options')?.body).toEqual({ proof: { method: 'passkey', assertion: { id: 'old' } } });
  });

  it('beginTotpSetup returns the secret and sends proof when a factor exists', async () => {
    routes['GET /api/auth/step-up'] = () => enrolledStatus;
    routes['POST /api/auth/step-up/challenge'] = () => ({ methods: ['pin'] });
    routes['POST /api/auth/step-up/totp/enroll'] = () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x' });
    prompt({ method: 'pin', pin: '482916' });
    const out = await beginTotpSetup();
    expect(out.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(calls.find((c) => c.path === '/api/auth/step-up/totp/enroll')?.body).toEqual({ proof: { method: 'pin', pin: '482916' } });
  });
});
