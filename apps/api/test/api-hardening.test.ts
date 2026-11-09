import { enrollTestPin, TEST_PIN } from './helpers/stepup.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { transactionsRepo } from '../src/repos/transactions.js';
import {
  ValidationError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError
} from '../src/core/errors.js';

describe('Phase 9: API Hardening, Errors, and Validation (H10, M-errors)', () => {
  let server: Server;
  let baseUrl: string;
  const userId = '00000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(async () => {
    // Seed user profile if not present
    if (!(await profilesRepo.getById(userId))) {
      await profilesRepo.upsert({
        id: userId,
        email: 'hardening@pocketful.demo',
        display_name: 'Hardening Tester',
        home_address: '123 Test St',
        home_lat: 37.7749,
        home_lng: -122.4194,
        guilt_free_cap_minor: 25000,
        currency: 'USD',
        max_distance_km: 15,
        opt_in_mood: true,
        opt_in_tracking: true
      });
    }
  });

  it('rejects malformed JSON syntax with 400 Bad Request and VALIDATION_FAILED code', async () => {
    const res = await fetch(`${baseUrl}/healthz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"invalid_json_payload: missing_bracket'
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('VALIDATION_FAILED');
    expect(json.error.message).toContain('Malformed JSON');
  });

  it('rejects payloads exceeding 100kb with 413 Payload Too Large', async () => {
    const token = await createDevToken(userId, 'hardening@pocketful.demo');
    // Generate oversized JSON payload > 100kb
    const hugeString = 'A'.repeat(120 * 1024);
    const res = await fetch(`${baseUrl}/api/me/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ hugeField: hugeString })
    });

    expect(res.status).toBe(413);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('VALIDATION_FAILED');
  });

  it('sets secure Helmet HTTP headers on responses', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-xss-protection')).toBeDefined();
  });

  it('propagates and echoes x-request-id header throughout middleware stack', async () => {
    const customReqId = 'custom_req_trace_987654';
    const token = await createDevToken(userId, 'hardening@pocketful.demo');
    const res = await fetch(`${baseUrl}/api/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-request-id': customReqId
      }
    });

    expect(res.headers.get('x-request-id')).toBe(customReqId);
    const json = (await res.json()) as { requestId?: string };
    expect(json.requestId).toBe(customReqId);
  });

  it('typed AppError hierarchy instantiates correct HTTP status codes and error codes', () => {
    const vErr = new ValidationError('Bad field', { field: 'name' });
    expect(vErr.statusCode).toBe(400);
    expect(vErr.code).toBe('VALIDATION_FAILED');

    const aErr = new AuthenticationError();
    expect(aErr.statusCode).toBe(401);
    expect(aErr.code).toBe('UNAUTHENTICATED');

    const fErr = new ForbiddenError();
    expect(fErr.statusCode).toBe(403);
    expect(fErr.code).toBe('FORBIDDEN');

    const nErr = new NotFoundError();
    expect(nErr.statusCode).toBe(404);
    expect(nErr.code).toBe('NOT_FOUND');

    const cErr = new ConflictError();
    expect(cErr.statusCode).toBe(409);
    expect(cErr.code).toBe('CONFLICT');

    const rErr = new RateLimitError();
    expect(rErr.statusCode).toBe(429);
    expect(rErr.code).toBe('RATE_LIMITED');
  });

  it('GET /api/me/export returns comprehensive GDPR bundle with download header', async () => {
    const token = await createDevToken(userId, 'hardening@pocketful.demo');

    // Add sample transaction for export
    await transactionsRepo.insert({
      id: '00000000-0000-4000-8000-000000000077',
      user_id: userId,
      source: 'manual',
      source_ref: 'ref_export_test',
      occurred_at: new Date().toISOString(),
      amount_minor: 1500,
      currency: 'USD',
      merchant_raw: 'GDPR Bakery',
      merchant_norm: 'gdpr bakery',
      kind: 'leisure',
      category: 'cafes',
      venue_id: null,
      linked_suggestion_id: null,
      match_type: 'organic',
      confidence: 1.0,
      needs_question: false,
      user_rating: null,
      excluded: false
    });

    const res = await fetch(`${baseUrl}/api/me/export`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('pocketful-data-export-');

    const json = (await res.json()) as {
      ok: boolean;
      data: {
        exported_at: string;
        user_id: string;
        profile: unknown;
        transactions: unknown[];
      };
    };

    expect(json.ok).toBe(true);
    expect(json.data.user_id).toBe(userId);
    expect(json.data.profile).toBeDefined();
    expect(json.data.transactions.length).toBeGreaterThan(0);
  });

  it('DELETE /api/me/data stages Guardian approval and requires step-up proof before erasing account', async () => {
    const token = await createDevToken(userId, 'hardening@pocketful.demo');

    // 1. Initial DELETE stages a Guardian approval
    const res = await fetch(`${baseUrl}/api/me/data`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        status: string;
        requiresApproval: boolean;
        approval: { id: string; action_type: string; status: string };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.requiresApproval).toBe(true);
    expect(json.data.approval.action_type).toBe('delete_data');

    const approvalId = json.data.approval.id;

    await enrollTestPin(baseUrl, token);

    // 2. Obtain step-up challenge nonce
    const challengeRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    const challengeJson = (await challengeRes.json()) as {
      ok: boolean;
      data: { challengeNonce: string; expiresAt: string; method: string };
    };
    expect(challengeJson.ok).toBe(true);
    const { challengeNonce } = challengeJson.data;
    const boundHashLegacy = 'x'.repeat(64);

    const decide = (body: Record<string, unknown>, key: string) =>
      fetch(`${baseUrl}/api/approvals/${approvalId}/decide`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `${key}_${approvalId}_${Date.now()}`
        },
        body: JSON.stringify(body)
      });

    // Negative 1: the OLD forgeable proof (sha256(nonce:boundHash)) is no longer accepted.
    const forged = crypto.createHash('sha256').update(`${challengeNonce}:${boundHashLegacy}`).digest('hex');
    expect((await decide({ decision: 'approve', stepUpProof: forged }, 'forged')).status).toBe(403);
    // Negative 2: challenge response carries nothing a client could turn into a proof.
    expect(Object.keys(challengeJson.data).sort()).toEqual(['challengeNonce', 'expiresAt', 'methods']);
    // Negative 3: nonce without a PIN, and a PIN without the nonce, are both rejected.
    expect((await decide({ decision: 'approve', challengeNonce }, 'nopin')).status).toBe(403);
    expect((await decide({ decision: 'approve', proof: { method: 'pin', pin: TEST_PIN } }, 'nononce')).status).toBe(403);
    // Negative 4: wrong PIN is rejected and the nonce survives for the legitimate user.
    expect((await decide({ decision: 'approve', proof: { method: 'pin', pin: '135792' }, challengeNonce }, 'wrongpin')).status).toBe(403);

    // 3. Execute erasure approval with the real PIN and the bound nonce
    const decideRes = await decide({ decision: 'approve', proof: { method: 'pin', pin: TEST_PIN }, challengeNonce }, 'valid');
    expect(decideRes.status).toBe(200);

    // Profile should no longer exist
    const profileAfter = await profilesRepo.getById(userId);
    expect(profileAfter).toBeNull();
  });
});
