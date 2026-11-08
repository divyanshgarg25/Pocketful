import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { validateConfig } from '../src/core/config.js';

const apiDir = path.resolve(__dirname, '..');

const PROD = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://prod-project.supabase.co',
  SUPABASE_ANON_KEY: 'prod-anon-key-abc-123',
  SUPABASE_SERVICE_ROLE_KEY: 'prod-service-role-key-xyz-789',
  PAYPAL_CLIENT_ID: 'prod-paypal-live-client-id',
  PAYPAL_CLIENT_SECRET: 'prod-paypal-live-secret-key',
  PAYPAL_WEBHOOK_ID: 'prod-webhook-id-456',
  GEMINI_API_KEY: 'prod-gemini-ai-key-789',
  CORS_ORIGIN: 'https://pocketful-web.onrender.com',
  APP_BASE_URL: 'https://pocketful-web.onrender.com',
  SUPABASE_JWT_SECRET: 'prod-jwt-secret-xyz-789-abcdef-supersecret',
  STEP_UP_ENC_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  PAYPAL_PAYEE_MERCHANT_ID: 'ABCDE12345678'
};

describe('M1: NODE_ENV boot guard', () => {
  it('refuses to boot when NODE_ENV is unset and APP_BASE_URL is a public host', () => {
    expect(() => validateConfig({ APP_BASE_URL: 'https://pocketful-web.onrender.com' })).toThrow(/NODE_ENV/);
  });

  it('also refuses an empty-string NODE_ENV (a blank dashboard field)', () => {
    expect(() => validateConfig({ NODE_ENV: '', APP_BASE_URL: 'https://pocketful-web.onrender.com' })).toThrow(/NODE_ENV/);
  });

  it('treats every non-loopback host as non-local, including http and IP addresses', () => {
    for (const url of ['http://pocketful.example.com', 'https://203.0.113.9', 'https://localhost.evil.example']) {
      expect(() => validateConfig({ APP_BASE_URL: url }), url).toThrow(/NODE_ENV/);
    }
  });

  it('still allows a bare local dev setup with NODE_ENV unset', () => {
    for (const url of [undefined, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'http://app.localhost:5173']) {
      const cfg = validateConfig(url ? { APP_BASE_URL: url } : {});
      expect(cfg.NODE_ENV).toBe('development');
    }
  });

  it('an explicit NODE_ENV is always honoured (no change for development/test/production)', () => {
    expect(validateConfig({ NODE_ENV: 'development', APP_BASE_URL: 'https://staging.example.com' }).NODE_ENV).toBe('development');
    expect(validateConfig({ NODE_ENV: 'test', APP_BASE_URL: 'https://staging.example.com' }).NODE_ENV).toBe('test');
    expect(validateConfig(PROD as never).NODE_ENV).toBe('production');
  });

  it('a misspelled NODE_ENV is still rejected by the schema', () => {
    expect(() => validateConfig({ NODE_ENV: 'prod' })).toThrow(/NODE_ENV/);
  });

  it('a real process with NODE_ENV unset and a public APP_BASE_URL exits non-zero with a clear message', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, APP_BASE_URL: 'https://pocketful-web.onrender.com', PORT: '0' };
    delete env['NODE_ENV'];
    delete env['VITEST'];
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: apiDir, env, encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/NODE_ENV/);
  }, 40_000);
});

describe('M2: TRUST_PROXY_HOPS configuration', () => {
  it('defaults to 1', () => {
    expect(validateConfig({}).TRUST_PROXY_HOPS).toBe(1);
  });

  it('accepts integers 0..10', () => {
    expect(validateConfig({ TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
    expect(validateConfig({ TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
    expect(validateConfig({ TRUST_PROXY_HOPS: '10' }).TRUST_PROXY_HOPS).toBe(10);
  });

  it('rejects negatives, fractions, junk, and absurd values (never "true", which would trust every hop)', () => {
    for (const bad of ['-1', '1.5', 'abc', 'true', '11', '999', '']) {
      expect(() => validateConfig({ TRUST_PROXY_HOPS: bad }), bad).toThrow(/TRUST_PROXY_HOPS/);
    }
  });

  it('index.ts reads the setting from config instead of a hard-coded hop count', () => {
    const src = fs.readFileSync(path.join(apiDir, 'src/index.ts'), 'utf-8');
    expect(src).toMatch(/app\.set\(\s*'trust proxy',\s*config\.TRUST_PROXY_HOPS\s*\)/);
    expect(src).not.toMatch(/app\.set\(\s*'trust proxy',\s*(1|true)\s*\)/);
  });
});

describe('H1: cooldown configuration', () => {
  it('defaults to 0 outside production and 24 in production', () => {
    expect(validateConfig({}).STEPUP_ENROLL_COOLDOWN_HOURS).toBe(0);
    expect(validateConfig({ NODE_ENV: 'test' }).STEPUP_ENROLL_COOLDOWN_HOURS).toBe(0);
    expect(validateConfig(PROD as never).STEPUP_ENROLL_COOLDOWN_HOURS).toBe(24);
  });

  it('production refuses a cooldown below 1 hour (including 0 and negatives)', () => {
    for (const v of ['0', '0.5', '-3']) {
      expect(() => validateConfig({ ...PROD, STEPUP_ENROLL_COOLDOWN_HOURS: v } as never), v).toThrow(/STEPUP_ENROLL_COOLDOWN_HOURS/);
    }
  });

  it('production accepts any value >= 1 and non-production accepts 0', () => {
    expect(validateConfig({ ...PROD, STEPUP_ENROLL_COOLDOWN_HOURS: '1' } as never).STEPUP_ENROLL_COOLDOWN_HOURS).toBe(1);
    expect(validateConfig({ ...PROD, STEPUP_ENROLL_COOLDOWN_HOURS: '72' } as never).STEPUP_ENROLL_COOLDOWN_HOURS).toBe(72);
    expect(validateConfig({ NODE_ENV: 'development', STEPUP_ENROLL_COOLDOWN_HOURS: '0' }).STEPUP_ENROLL_COOLDOWN_HOURS).toBe(0);
  });

  it('rejects non-numeric values everywhere', () => {
    expect(() => validateConfig({ STEPUP_ENROLL_COOLDOWN_HOURS: 'soon' })).toThrow(/STEPUP_ENROLL_COOLDOWN_HOURS/);
  });
});
