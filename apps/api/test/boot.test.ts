import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { validateConfig } from '../src/core/config.js';

describe('Phase 1: Boot Guard & Configuration Hardening (C2)', () => {
  let server: Server;
  let baseUrl: string;

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

  const validProductionEnv = {
    NODE_ENV: 'production',
    PORT: '3001',
    DEMO_MODE: 'false',
    SUPABASE_URL: 'https://prod-project.supabase.co',
    SUPABASE_ANON_KEY: 'prod-anon-key-abc-123',
    SUPABASE_SERVICE_ROLE_KEY: 'prod-service-role-key-xyz-789',
    PAYPAL_CLIENT_ID: 'prod-paypal-live-client-id',
    PAYPAL_CLIENT_SECRET: 'prod-paypal-live-secret-key',
    PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com',
    PAYPAL_WEBHOOK_ID: 'prod-webhook-id-456',
    GEMINI_API_KEY: 'prod-gemini-ai-key-789',
    GEMINI_MODEL: 'gemini-2.5-flash',
    CORS_ORIGIN: 'https://pocketful-web.onrender.com',
    APP_BASE_URL: 'https://pocketful-web.onrender.com',
    VITE_API_URL: 'https://pocketful-api.onrender.com',
    DEFAULT_CURRENCY: 'USD',
    SUPABASE_JWT_SECRET: 'prod-jwt-secret-xyz-789-abcdef-supersecret',
    STEP_UP_ENC_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PAYPAL_PAYEE_MERCHANT_ID: 'ABCDE12345678'
  };

  it('allows boot with fully valid production credentials', () => {
    const config = validateConfig(validProductionEnv);
    expect(config.NODE_ENV).toBe('production');
    expect(config.DEMO_MODE).toBe(false);
    expect(config.PAYPAL_SIMULATE).toBe(false);
    expect(config.GEMINI_SIMULATE).toBe(false);
    expect(config.PLACES_LIVE).toBe(true);
    expect(config.AUTH_ALLOW_DEMO).toBe(false);
  });

  // ---- C3: the receiving PayPal account must be named in production ------------------------------------
  it('refuses to boot in production without a PayPal payee (merchant id or email)', () => {
    const env: Record<string, string | undefined> = { ...validProductionEnv };
    delete env['PAYPAL_PAYEE_MERCHANT_ID'];
    expect(() => validateConfig(env as never)).toThrow(/PAYPAL_PAYEE/);
  });

  it('accepts either a merchant id or an email as the production payee', () => {
    const env: Record<string, string | undefined> = { ...validProductionEnv };
    delete env['PAYPAL_PAYEE_MERCHANT_ID'];
    expect(validateConfig({ ...env, PAYPAL_PAYEE_EMAIL: 'payments@pocketful.example' } as never).PAYPAL_PAYEE_EMAIL).toBe('payments@pocketful.example');
    expect(validateConfig(validProductionEnv).PAYPAL_PAYEE_MERCHANT_ID).toBe('ABCDE12345678');
  });

  it.each(['abc', 'abcde12345678', 'ABCDE1234567', 'ABCDE123456789', 'ABCDE-2345678'])('rejects a malformed merchant id %j', (id) => {
    expect(() => validateConfig({ ...validProductionEnv, PAYPAL_PAYEE_MERCHANT_ID: id })).toThrow(/PAYPAL_PAYEE_MERCHANT_ID/);
  });

  it('rejects a malformed payee email', () => {
    expect(() => validateConfig({ NODE_ENV: 'development', PAYPAL_PAYEE_EMAIL: 'not-an-email' })).toThrow(/PAYPAL_PAYEE_EMAIL/);
  });

  it('the payee is optional outside production', () => {
    expect(validateConfig({ NODE_ENV: 'development' }).PAYPAL_PAYEE_MERCHANT_ID).toBeUndefined();
  });

  // ---- E5: CORS_ORIGIN must be explicit https in production (the schema default is localhost) -------
  it('refuses to boot in production when CORS_ORIGIN is omitted (the localhost default must not slip through)', () => {
    const env: Record<string, string | undefined> = { ...validProductionEnv };
    delete env['CORS_ORIGIN'];
    expect(() => validateConfig(env as never)).toThrow(/CORS_ORIGIN/);
  });

  it.each([
    ['an http origin', 'http://pocketful-web.onrender.com'],
    ['localhost', 'https://localhost:5173'],
    ['loopback', 'https://127.0.0.1'],
    ['a wildcard subdomain', 'https://*.onrender.com'],
    ['a malformed value', 'not a url'],
    ['one bad origin in a list', 'https://pocketful-web.onrender.com, http://evil.example']
  ])('refuses to boot in production with CORS_ORIGIN set to %s', (_n, origin) => {
    expect(() => validateConfig({ ...validProductionEnv, CORS_ORIGIN: origin })).toThrow(/CORS_ORIGIN/);
  });

  it('accepts one or several explicit https origins in production', () => {
    expect(validateConfig({ ...validProductionEnv, CORS_ORIGIN: 'https://pocketful-web.onrender.com' }).CORS_ORIGIN).toBe('https://pocketful-web.onrender.com');
    expect(() => validateConfig({ ...validProductionEnv, CORS_ORIGIN: 'https://a.example.com, https://b.example.com' })).not.toThrow();
  });

  // ---- B1: step-up / WebAuthn boot guards ----------------------------------------------------------
  it('refuses to boot if STEP_UP_TEST_MODE=true in production', () => {
    expect(() => validateConfig({ ...validProductionEnv, STEP_UP_TEST_MODE: 'true' })).toThrow(/STEP_UP_TEST_MODE cannot be true in production/);
    expect(() => validateConfig({ ...validProductionEnv, STEP_UP_TEST_MODE: '1' })).toThrow(/STEP_UP_TEST_MODE cannot be true in production/);
  });

  it('production config always has the test authenticator off, even when the flag is explicitly false', () => {
    expect(validateConfig(validProductionEnv).STEP_UP_TEST_MODE).toBe(false);
    expect(validateConfig({ ...validProductionEnv, STEP_UP_TEST_MODE: 'false' }).STEP_UP_TEST_MODE).toBe(false);
  });

  it('allows STEP_UP_TEST_MODE outside production, defaults it off, and gives a per-process secret', () => {
    const dev = validateConfig({ NODE_ENV: 'development', STEP_UP_TEST_MODE: 'true' });
    expect(dev.STEP_UP_TEST_MODE).toBe(true);
    expect(dev.STEP_UP_TEST_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(validateConfig({ NODE_ENV: 'development' }).STEP_UP_TEST_MODE).toBe(false);
    expect(validateConfig({ NODE_ENV: 'development', STEP_UP_TEST_SECRET: 'fixed' }).STEP_UP_TEST_SECRET).toBe('fixed');
  });

  it.each([
    ['missing', undefined],
    ['too short', 'abcd'],
    ['non-hex', 'z'.repeat(64)],
    ['wrong length', '0'.repeat(63)]
  ])('refuses to boot in production with a %s STEP_UP_ENC_KEY', (_n, key) => {
    const env: Record<string, string | undefined> = { ...validProductionEnv, STEP_UP_ENC_KEY: key };
    if (key === undefined) delete env['STEP_UP_ENC_KEY'];
    expect(() => validateConfig(env as never)).toThrow(/STEP_UP_ENC_KEY must be 64 hex/);
  });

  it('derives the WebAuthn RP ID and origin from APP_BASE_URL', () => {
    const c = validateConfig(validProductionEnv);
    expect(c.WEBAUTHN_RP_ID).toBe('pocketful-web.onrender.com');
    expect(c.WEBAUTHN_ORIGINS).toEqual(['https://pocketful-web.onrender.com']);
  });

  it.each([
    ['a different domain', { WEBAUTHN_RP_ID: 'evil.example' }],
    ['localhost', { WEBAUTHN_RP_ID: 'localhost' }],
    ['a wildcard', { WEBAUTHN_RP_ID: '*.onrender.com' }],
    ['an IP address', { WEBAUTHN_RP_ID: '10.0.0.1' }]
  ])('refuses to boot in production with WEBAUTHN_RP_ID set to %s', (_n, extra) => {
    expect(() => validateConfig({ ...validProductionEnv, ...extra })).toThrow(/WEBAUTHN_RP_ID/);
  });

  it('accepts a parent-domain RP ID in production', () => {
    expect(validateConfig({ ...validProductionEnv, WEBAUTHN_RP_ID: 'onrender.com' }).WEBAUTHN_RP_ID).toBe('onrender.com');
  });

  it.each([
    ['an http origin', 'http://pocketful-web.onrender.com'],
    ['an origin outside the RP ID', 'https://evil.example'],
    ['a malformed origin', 'not a url']
  ])('refuses to boot in production with WEBAUTHN_ORIGINS containing %s', (_n, origin) => {
    expect(() => validateConfig({ ...validProductionEnv, WEBAUTHN_ORIGINS: origin })).toThrow(/WEBAUTHN_ORIGINS/);
  });

  it('refuses to boot if PAYPAL_SIMULATE=true in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        PAYPAL_SIMULATE: 'true'
      })
    ).toThrow(/PAYPAL_SIMULATE cannot be true in production/);
  });

  it('refuses to boot if GEMINI_SIMULATE=true in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        GEMINI_SIMULATE: 'true'
      })
    ).toThrow(/GEMINI_SIMULATE cannot be true in production/);
  });

  it('refuses to boot if AUTH_ALLOW_DEMO=true in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        AUTH_ALLOW_DEMO: 'true'
      })
    ).toThrow(/AUTH_ALLOW_DEMO cannot be true in production/);
  });

  it('refuses to boot if SUPABASE_JWT_SECRET is missing or demo in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        SUPABASE_JWT_SECRET: undefined
      })
    ).toThrow(/SUPABASE_JWT_SECRET missing or using demo placeholder/);

    expect(() =>
      validateConfig({
        ...validProductionEnv,
        SUPABASE_JWT_SECRET: 'demo-secret-placeholder'
      })
    ).toThrow(/SUPABASE_JWT_SECRET missing or using demo placeholder/);
  });

  it('refuses to boot if DEMO_MODE=true in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        DEMO_MODE: 'true'
      })
    ).toThrow(/DEMO_MODE cannot be true in production/);
  });

  it('refuses to boot if SUPABASE_URL is missing or demo in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        SUPABASE_URL: 'https://demo.supabase.co'
      })
    ).toThrow(/SUPABASE_URL missing or using demo placeholder/);

    expect(() =>
      validateConfig({
        ...validProductionEnv,
        SUPABASE_URL: ''
      })
    ).toThrow(/SUPABASE_URL/);
  });

  it('refuses to boot if SUPABASE_SERVICE_ROLE_KEY is missing or demo in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        SUPABASE_SERVICE_ROLE_KEY: 'demo-service-role-key'
      })
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY missing or using demo placeholder/);
  });

  it('refuses to boot if PAYPAL_CLIENT_ID is missing or demo in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        PAYPAL_CLIENT_ID: 'demo-paypal-client-id'
      })
    ).toThrow(/PAYPAL_CLIENT_ID missing or using demo placeholder/);
  });

  it('refuses to boot if PAYPAL_CLIENT_SECRET is missing or demo in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        PAYPAL_CLIENT_SECRET: 'demo-paypal-client-secret'
      })
    ).toThrow(/PAYPAL_CLIENT_SECRET missing or using demo placeholder/);
  });

  it('refuses to boot if PAYPAL_WEBHOOK_ID is missing or demo in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        PAYPAL_WEBHOOK_ID: 'demo-webhook-id'
      })
    ).toThrow(/PAYPAL_WEBHOOK_ID missing or using demo placeholder/);
  });

  it('refuses to boot if GEMINI_API_KEY is missing or demo in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        GEMINI_API_KEY: 'demo-gemini-key'
      })
    ).toThrow(/GEMINI_API_KEY missing or using demo placeholder/);
  });

  it('refuses to boot if CORS_ORIGIN is wildcard * or empty in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        CORS_ORIGIN: '*'
      })
    ).toThrow(/CORS_ORIGIN missing or wildcard/);

    expect(() =>
      validateConfig({
        ...validProductionEnv,
        CORS_ORIGIN: ''
      })
    ).toThrow(/CORS_ORIGIN missing or wildcard/);
  });

  it('refuses to boot if APP_BASE_URL does not start with https:// in production', () => {
    expect(() =>
      validateConfig({
        ...validProductionEnv,
        APP_BASE_URL: 'http://insecure-domain.com'
      })
    ).toThrow(/APP_BASE_URL must use https:\/\//);
  });

  it('public /healthz returns strictly { status: "ok" } without leaking internal state', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
    expect(body.database).toBeUndefined();
    expect(body.paypal).toBeUndefined();
    expect(body.gemini).toBeUndefined();
  });

  it('readiness check /readyz returns status: ready when database is available', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ready' });
  });
});
