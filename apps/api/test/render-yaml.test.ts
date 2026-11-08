import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateConfig } from '../src/core/config.js';

/**
 * E5: render.yaml is what actually deploys. It must (a) declare every variable the production boot guard requires,
 * and (b) when its secrets are filled in, produce a config that boots. Required variables are DISCOVERED by deleting
 * each one from a known-good environment, not read from a hand-kept list.
 */
const yaml = fs.readFileSync(path.resolve(__dirname, '../../../render.yaml'), 'utf-8').replace(/\r\n/g, '\n');
const apiBlock = yaml.slice(yaml.indexOf('name: pocketful-api'), yaml.indexOf('name: pocketful-web'));
const webBlock = yaml.slice(yaml.indexOf('name: pocketful-web'));

type Declared = Map<string, { value?: string; sync: boolean }>;
function envVars(block: string): Declared {
  const out: Declared = new Map();
  const re = /^\s+- key: (\S+)\n((?:\s{8,}(?!- key)\S.*\n?)*)/gm;
  for (const m of block.matchAll(re)) {
    const body = m[2] ?? '';
    const value = /value:\s*"?([^"\n]*)"?/.exec(body)?.[1];
    out.set(m[1]!, { value, sync: /sync:\s*false/.test(body) });
  }
  return out;
}
const api = envVars(apiBlock);
const web = envVars(webBlock);

// Realistic placeholders for the secrets that render.yaml leaves to the dashboard (sync: false).
const SECRET_FILL: Record<string, string> = {
  SUPABASE_URL: 'https://abcdefghij.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key-real-looking-value',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-real-looking-value',
  SUPABASE_JWT_SECRET: 'prod-jwt-secret-xyz-789-abcdef-supersecret',
  STEP_UP_ENC_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  PAYPAL_CLIENT_ID: 'AbCdEf-live-looking-client-id',
  PAYPAL_CLIENT_SECRET: 'live-looking-client-secret-123',
  PAYPAL_WEBHOOK_ID: '8WH12345ABCDE6789',
  PAYPAL_PAYEE_MERCHANT_ID: 'ABCDE12345678',
  GEMINI_API_KEY: 'AIzaSyLooksLikeARealGeminiKey123456'
};

function renderEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of api) {
    if (v.sync) {
      if (!(k in SECRET_FILL)) throw new Error(`render.yaml has a dashboard-only secret ${k} this test has no placeholder for`);
      env[k] = SECRET_FILL[k]!;
    } else if (v.value !== undefined) env[k] = v.value;
  }
  return env;
}

describe('E5: render.yaml matches the production boot guard', () => {
  it('parses the API env block', () => {
    expect(api.size).toBeGreaterThan(10);
    expect(api.get('NODE_ENV')?.value).toBe('production');
  });

  it('boots: render.yaml as written, with its dashboard secrets filled, passes validateConfig in production', () => {
    const cfg = validateConfig(renderEnv() as never);
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.STEP_UP_TEST_MODE).toBe(false);
    expect(cfg.AUTH_ALLOW_DEMO).toBe(false);
    expect(cfg.WEBAUTHN_RP_ID).toBe('pocketful-web.onrender.com');
    expect(cfg.WEBAUTHN_ORIGINS).toEqual(['https://pocketful-web.onrender.com']);
  });

  it('declares EVERY variable the production boot guard requires (discovered by deleting each one)', () => {
    const env = renderEnv();
    const required: string[] = [];
    for (const key of Object.keys(env)) {
      const without = { ...env };
      delete without[key];
      try {
        validateConfig(without as never);
      } catch {
        required.push(key);
      }
    }
    // sanity: the discovery really finds the security-critical ones
    expect(required).toEqual(expect.arrayContaining(['SUPABASE_JWT_SECRET', 'STEP_UP_ENC_KEY', 'PAYPAL_WEBHOOK_ID', 'CORS_ORIGIN', 'APP_BASE_URL']));
    for (const k of required) expect(api.has(k), `${k} is required to boot but missing from render.yaml`).toBe(true);
  });

  it('would catch a missing declaration: a required variable absent from render.yaml is detected', () => {
    const env = renderEnv();
    delete env['STEP_UP_ENC_KEY'];
    expect(() => validateConfig(env as never)).toThrow(/STEP_UP_ENC_KEY/);
  });

  it('never sets a demo/simulation switch to a permissive value', () => {
    for (const k of ['DEMO_MODE', 'PAYPAL_SIMULATE', 'GEMINI_SIMULATE', 'AUTH_ALLOW_DEMO', 'STEP_UP_TEST_MODE']) {
      const v = api.get(k)?.value;
      expect(v === undefined || v === 'false', `${k}=${v}`).toBe(true);
    }
  });

  it('commits no secret values: every secret-looking variable is dashboard-only (sync: false)', () => {
    for (const [k, v] of api) {
      if (/SECRET|KEY|TOKEN|PASSWORD|WEBHOOK_ID/.test(k)) expect(v.sync && v.value === undefined, `${k} must not have a committed value`).toBe(true);
    }
    for (const [k, v] of web) {
      if (/SECRET|SERVICE|PASSWORD/.test(k)) expect(v.value, k).toBeUndefined();
    }
  });

  it('pins the same Node major as the repo for both services', () => {
    const nvmrc = fs.readFileSync(path.resolve(__dirname, '../../../.nvmrc'), 'utf-8').trim();
    expect(api.get('NODE_VERSION')?.value).toBe(nvmrc);
    expect(web.get('NODE_VERSION')?.value).toBe(nvmrc);
  });

  it('web: build-time variables point at this deployment and the SPA falls back to index.html', () => {
    expect(web.get('VITE_API_URL')?.value).toMatch(/^https:\/\//);
    expect(web.get('VITE_SUPABASE_URL')?.sync).toBe(true);
    expect(web.get('VITE_SUPABASE_ANON_KEY')?.sync).toBe(true);
    expect(webBlock).toMatch(/type: rewrite\n\s+source: \/\*\n\s+destination: \/index\.html/);
    // the API must allow exactly this web origin, and the SPA must call exactly this API
    expect(api.get('CORS_ORIGIN')?.value).toBe(api.get('APP_BASE_URL')?.value);
  });

  it('the health check path is a route the API really serves', () => {
    const hc = /healthCheckPath:\s*(\S+)/.exec(apiBlock)?.[1];
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/healthz.ts'), 'utf-8');
    expect(src).toContain(`'${hc}'`);
  });
});
