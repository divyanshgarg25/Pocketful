import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: () => true
}));
import { sealApproval, registerStepUpPrompter } from '../src/lib/api';

type Call = { method: string; path: string; body: unknown; headers: Headers };
let calls: Call[];
let approvalStatus: string;
let prompts: number;

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, message = 'm') =>
  new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  prompts = 0;
  approvalStatus = 'pending';
  registerStepUpPrompter(async () => {
    prompts++;
    return { method: 'pin', pin: '482916' };
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined, headers: new Headers(init?.headers) });
    if (path === '/api/auth/step-up') return ok({ enrolled: true, methods: ['pin'] });
    if (path === '/api/approvals/a1' && method === 'GET') return ok({ approval: { status: approvalStatus } });
    if (path === '/api/approvals/a1/challenge') return ok({ challengeNonce: 'n1', methods: ['pin'] });
    if (path === '/api/approvals/a1/decide') return ok({ status: 'executed', result: { sent: 3 } });
    if (path === '/api/approvals/a1/retry') return ok({ status: 'executed', result: { sent: 3 } });
    return fail(500, 'INTERNAL_ERROR', `unrouted ${method} ${path}`);
  }));
});
afterEach(() => { registerStepUpPrompter(null); vi.unstubAllGlobals(); });

const paths = () => calls.map((c) => `${c.method} ${c.path}`);

describe('E3: sealApproval', () => {
  it('a pending approval goes through /decide with the proof, nonce and idempotency key', async () => {
    const r = await sealApproval('a1', 'group_seal_a1_key_12345');
    expect(r.status).toBe('executed');
    const decide = calls.find((c) => c.path.endsWith('/decide'))!;
    expect(decide.body).toEqual({ decision: 'approve', proof: { method: 'pin', pin: '482916' }, challengeNonce: 'n1' });
    expect(decide.headers.get('Idempotency-Key')).toBe('group_seal_a1_key_12345');
    expect(paths().some((p) => p.endsWith('/retry'))).toBe(false);
  });

  it('a FAILED approval is retried via /retry (fresh verification), not by replaying the old decision', async () => {
    approvalStatus = 'failed';
    await sealApproval('a1', 'group_seal_a1_key_12345');
    expect(paths()).toContain('POST /api/approvals/a1/retry');
    expect(paths()).not.toContain('POST /api/approvals/a1/decide');
    const retry = calls.find((c) => c.path.endsWith('/retry'))!;
    expect(retry.body).toEqual({ proof: { method: 'pin', pin: '482916' }, challengeNonce: 'n1' });
    expect(prompts).toBe(1);
  });

  it('checks the approval BEFORE asking the user to verify, so a no-op never prompts', async () => {
    for (const status of ['executed', 'executing', 'expired', 'denied', 'cancelled']) {
      approvalStatus = status;
      calls = [];
      prompts = 0;
      await sealApproval('a1', 'k_12345678901234567').catch(() => undefined);
      expect(prompts, status).toBe(0);
      expect(paths().some((p) => p.endsWith('/challenge') || p.endsWith('/decide') || p.endsWith('/retry')), status).toBe(false);
    }
  });

  it('an already-executed approval is reported as done, not re-run', async () => {
    approvalStatus = 'executed';
    expect(await sealApproval('a1', 'k_12345678901234567')).toMatchObject({ status: 'executed', alreadyDone: true });
  });

  it.each([
    ['executing', 'CONCURRENT_ACTION'],
    ['expired', 'APPROVAL_EXPIRED'],
    ['denied', 'CONFLICT'],
    ['cancelled', 'CONFLICT']
  ])('a %s approval raises %s with a clear reason', async (status, code) => {
    approvalStatus = status;
    await expect(sealApproval('a1', 'k_12345678901234567')).rejects.toMatchObject({ code });
  });

  it('passes through the server\'s "finalizing" signal so the UI can show success, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/api/auth/step-up') return ok({ enrolled: true, methods: ['pin'] });
      if (path === '/api/approvals/a1') return ok({ approval: { status: 'approved' } });
      if (path.endsWith('/challenge')) return ok({ challengeNonce: 'n1', methods: ['pin'] });
      return ok({ status: 'executing', reconciling: true });
    }));
    expect(await sealApproval('a1', 'k_12345678901234567')).toMatchObject({ reconciling: true });
  });

  it('surfaces the server error (e.g. retry limit) so the caller can explain it', async () => {
    approvalStatus = 'failed';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/api/auth/step-up') return ok({ enrolled: true, methods: ['pin'] });
      if (path === '/api/approvals/a1') return ok({ approval: { status: 'failed' } });
      if (path.endsWith('/challenge')) return ok({ challengeNonce: 'n1', methods: ['pin'] });
      return fail(409, 'RETRY_LIMIT', 'Retry limit (3) reached.');
    }));
    await expect(sealApproval('a1', 'k_12345678901234567')).rejects.toMatchObject({ code: 'RETRY_LIMIT', status: 409 });
  });
});

describe('E3: every approval flow goes through sealApproval', () => {
  it('no screen or component posts to /api/approvals/:id/decide or calls obtainStepUp itself', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const root = path.resolve(__dirname, '../src');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.tsx$/.test(f.name)) {
          const t = fs.readFileSync(p, 'utf-8');
          if (/api\/approvals\/\$\{[^}]+\}\/(decide|retry)/.test(t) || /obtainStepUp\(/.test(t)) offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
