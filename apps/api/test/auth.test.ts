import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { SignJWT } from 'jose';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { config } from '../src/core/config.js';
import { initLocalSeed, localDb } from '../src/core/database.js';

describe('Phase 2: Authentication & JWT Verification (C1)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    initLocalSeed();
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

  it('rejects forged unsigned JWT (alg: none) with 401', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: '00000000-0000-4000-a000-000000000001',
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    ).toString('base64url');
    const forgedToken = `${header}.${payload}.`;

    const res = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${forgedToken}` }
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('INVALID_TOKEN');
  });

  it('rejects expired JWT with 401', async () => {
    const expiredToken = await new SignJWT({
      sub: '00000000-0000-4000-a000-000000000001',
      aud: 'authenticated'
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(config.SUPABASE_JWT_SECRET));

    const res = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${expiredToken}` }
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('INVALID_TOKEN');
  });

  it('rejects JWT with wrong audience with 401', async () => {
    const wrongAudToken = await new SignJWT({
      sub: '00000000-0000-4000-a000-000000000001',
      aud: 'anon'
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(config.SUPABASE_JWT_SECRET));

    const res = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${wrongAudToken}` }
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('INVALID_TOKEN');
  });

  it('rejects JWT with invalid signature (tampered payload or bad secret) with 401', async () => {
    const badSecretToken = await new SignJWT({
      sub: '00000000-0000-4000-a000-000000000001',
      aud: 'authenticated'
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('attacker-wrong-secret-key-123456789012'));

    const res = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${badSecretToken}` }
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('INVALID_TOKEN');
  });

  it('rejects legacy magic string demo tokens (demo_token, demo-token*, demo-anon-key) with 401', async () => {
    const magicTokens = ['demo_token', 'demo-token-aarav', 'demo-anon-key'];
    for (const token of magicTokens) {
      const res = await fetch(`${baseUrl}/api/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe('UNAUTHENTICATED');
    }
  });

  it('accepts valid signed token with 200', async () => {
    const token = await createDevToken('00000000-0000-4000-a000-000000000001', 'aarav@pocketful.demo', 'Aarav Sharma');
    const res = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.profile.id).toBe('00000000-0000-4000-a000-000000000001');
    expect(json.data.profile.name).toBe('Aarav Sharma');
  });

  it('issues signed dev token via POST /api/auth/dev-token in non-production mode', async () => {
    const res = await fetch(`${baseUrl}/api/auth/dev-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: '99999999-0000-4000-a000-000000000099',
        email: 'developer@pocketful.local',
        name: 'Dev Engineer'
      })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.token).toBeDefined();

    // Verify the returned token actually works on protected endpoints
    const verifyRes = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${json.data.token}` }
    });
    expect(verifyRes.status).toBe(200);
    const verifyJson = await verifyRes.json();
    expect(verifyJson.data.profile.id).toBe('99999999-0000-4000-a000-000000000099');
  });

  it('auto-provisions a fresh profile with safe non-zero caps and zero fake balances', async () => {
    const newUserId = 'aaaaaaaa-bbbb-4000-a000-cccccccccccc';
    const token = await createDevToken(newUserId, 'fresh@pocketful.local', 'Fresh User');

    const res = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.profile.per_action_cap_minor).toBe(25000);
    expect(json.data.profile.weekly_cap_minor).toBe(50000);
    expect(json.data.profile.guilt_free_cap_minor).toBe(15000);

    // Verify weekly pocket balance was initialized to 0 (no fake balance!)
    const pocket = localDb.pockets.get(`${newUserId}:weekly`);
    expect(pocket?.balance_minor).toBe(0);
  });

  it('enforces tenant isolation: User A cannot access User B resources', async () => {
    const userAId = '11111111-1111-4000-a000-111111111111';
    const userBId = '22222222-2222-4000-a000-222222222222';
    const tokenA = await createDevToken(userAId, 'usera@pocketful.local', 'User A');
    const tokenB = await createDevToken(userBId, 'userb@pocketful.local', 'User B');

    // Create an approval owned by User A
    const approvalId = 'app-user-a-isolated-001';
    localDb.approvals.set(approvalId, {
      id: approvalId,
      user_id: userAId,
      action_type: 'cancel_subscription',
      amount_minor: 4900,
      payload: { subscriptionId: 'sub-user-a-01' },
      status: 'pending',
      requires_step_up: false,
      step_up_method: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600000).toISOString(),
      decided_at: null,
      idempotency_key: 'idemp-iso-001'
    });

    // User A can access their approval
    const resA = await fetch(`${baseUrl}/api/approvals/${approvalId}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    expect(resA.status).toBe(200);

    // User B CANNOT access User A's approval
    const resB = await fetch(`${baseUrl}/api/approvals/${approvalId}`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    expect(resB.status).toBe(404); // Scoped to user_id or returns 404/403
  });
});
