import crypto from 'crypto';
import dotenv from 'dotenv';
import { z } from 'zod';
import { CurrencySchema } from './currency.js';

// Load environment variables from .env file if present
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_BASE_URL: z.string().default('http://localhost:5173'),
  VITE_API_URL: z.string().default('http://localhost:3001'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DEFAULT_CURRENCY: CurrencySchema.default('USD'),
  DEMO_MODE: z
    .string()
    .default('false')
    .transform((val) => val === 'true' || val === '1'),

  // Granular simulation and demo flags
  PAYPAL_SIMULATE: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true' || val === '1')),
  GEMINI_SIMULATE: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true' || val === '1')),
  PLACES_LIVE: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true' || val === '1')),
  AUTH_ALLOW_DEMO: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true' || val === '1')),

  // Step-up (WebAuthn / TOTP / PIN)
  STEP_UP_TEST_MODE: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true' || val === '1')),
  STEP_UP_TEST_SECRET: z.string().optional(),
  /** 32-byte key (64 hex chars) that encrypts TOTP secrets at rest (AES-256-GCM). Required in production. */
  STEP_UP_ENC_KEY: z.string().optional(),
  /** WebAuthn relying-party id. Defaults to the hostname of APP_BASE_URL. */
  WEBAUTHN_RP_ID: z.string().optional(),
  WEBAUTHN_RP_NAME: z.string().default('Pocketful'),
  /** Comma-separated allowed WebAuthn origins. Defaults to the origin of APP_BASE_URL. */
  WEBAUTHN_ORIGINS: z.string().optional(),
  /**
   * Hours a newly enrolled / replaced / reset step-up factor is barred from approving money actions.
   * Default 24 in production (and must be >= 1 there), 0 elsewhere so local dev and tests are not slowed down.
   */
  STEPUP_ENROLL_COOLDOWN_HOURS: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.trim() === '' || (Number.isFinite(Number(v)) && Number(v) >= 0), 'must be a non-negative number of hours')
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : Number(v))),
  /**
   * Number of reverse-proxy hops in front of the API (Render = 1). Express uses it to decide how much of
   * X-Forwarded-For to believe, which is what rate limiting keys on. A plain integer 0-10; never `true`.
   */
  TRUST_PROXY_HOPS: z
    .string()
    .regex(/^\d+$/, 'must be a whole number of proxy hops (0-10)')
    .transform(Number)
    .pipe(z.number().int().min(0).max(10))
    .optional(),

  // Supabase Configuration
  SUPABASE_URL: z.string().optional().default('https://demo.supabase.co'),
  SUPABASE_ANON_KEY: z.string().optional().default('demo-anon-key'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default('demo-service-role-key'),
  SUPABASE_JWT_SECRET: z.string().optional(),

  // Google Gemini AI
  GEMINI_API_KEY: z.string().optional().default('demo-gemini-key'),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  // PayPal Sandbox REST API
  PAYPAL_CLIENT_ID: z.string().optional().default('demo-paypal-client-id'),
  PAYPAL_CLIENT_SECRET: z.string().optional().default('demo-paypal-client-secret'),
  PAYPAL_BASE_URL: z.string().url().default('https://api-m.sandbox.paypal.com'),
  PAYPAL_WEBHOOK_ID: z.string().optional().default('demo-webhook-id'),
  /**
   * The PayPal account that RECEIVES friends' payments (Pocketful's own merchant account; there is no organizer
   * payout). Named explicitly on every order so funds cannot be routed anywhere else. Merchant id is preferred.
   */
  PAYPAL_PAYEE_MERCHANT_ID: z
    .string()
    .regex(/^[A-Z0-9]{13}$/, 'PAYPAL_PAYEE_MERCHANT_ID must be a 13-character PayPal merchant id')
    .optional(),
  PAYPAL_PAYEE_EMAIL: z.string().email('PAYPAL_PAYEE_EMAIL must be an email address').optional(),

  // OpenStreetMap & Nominatim
  OVERPASS_URL: z.string().url().default('https://overpass-api.de/api/interpreter'),
  NOMINATIM_UA: z.string().default('Pocketful/1.0 (divyanshgarg2504@gmail.com)')
});

export interface Config {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  APP_BASE_URL: string;
  VITE_API_URL: string;
  CORS_ORIGIN: string;
  DEFAULT_CURRENCY: z.infer<typeof CurrencySchema>;
  DEMO_MODE: boolean;
  PAYPAL_SIMULATE: boolean;
  GEMINI_SIMULATE: boolean;
  PLACES_LIVE: boolean;
  AUTH_ALLOW_DEMO: boolean;
  /** Enables the software "test" step-up authenticator. Forced false (and a boot error) in production. */
  STEP_UP_TEST_MODE: boolean;
  /** HMAC key the test authenticator signs with (random per process unless STEP_UP_TEST_SECRET is set). */
  STEP_UP_TEST_SECRET: string;
  /** 32-byte AES-256-GCM key for TOTP secrets at rest. */
  STEP_UP_ENC_KEY: string;
  WEBAUTHN_RP_ID: string;
  WEBAUTHN_RP_NAME: string;
  WEBAUTHN_ORIGINS: string[];
  STEPUP_ENROLL_COOLDOWN_HOURS: number;
  TRUST_PROXY_HOPS: number;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_BASE_URL: string;
  PAYPAL_WEBHOOK_ID: string;
  PAYPAL_PAYEE_MERCHANT_ID?: string | undefined;
  PAYPAL_PAYEE_EMAIL?: string | undefined;
  OVERPASS_URL: string;
  NOMINATIM_UA: string;
}

/** True for loopback / *.localhost hosts. An unparseable URL is not "local" (the URL check below reports it). */
function isLocalAppUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '0.0.0.0';
}

export function validateConfig(rawEnv: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(rawEnv);
  if (!result.success) {
    const errorDetails = result.error.issues.map((e) => `${e.path.map(String).join('.')}: ${e.message}`).join(', ');
    throw new Error(`[Config Error] Invalid environment configuration: ${errorDetails}`);
  }

  const data = result.data;
  const isProd = data.NODE_ENV === 'production';

  // M1: an unset NODE_ENV silently becomes 'development' (demo auth, simulated PayPal, no cooldown ...). That is fine on
  // a laptop and catastrophic on a public host, so a non-local APP_BASE_URL with NODE_ENV unset refuses to boot.
  if (rawEnv['NODE_ENV'] === undefined && !isLocalAppUrl(data.APP_BASE_URL)) {
    throw new Error(
      `[Boot Guard] NODE_ENV is not set but APP_BASE_URL (${data.APP_BASE_URL}) is not a local address. Set NODE_ENV explicitly (production for a real deployment).`
    );
  }

  if (isProd) {
    // In production, the server MUST refuse to start (throw) if any of these conditions are met:
    if (data.DEMO_MODE === true) {
      throw new Error('[Boot Guard] DEMO_MODE cannot be true in production');
    }
    if (data.PAYPAL_SIMULATE === true) {
      throw new Error('[Boot Guard] PAYPAL_SIMULATE cannot be true in production');
    }
    if (data.GEMINI_SIMULATE === true) {
      throw new Error('[Boot Guard] GEMINI_SIMULATE cannot be true in production');
    }
    if (data.AUTH_ALLOW_DEMO === true) {
      throw new Error('[Boot Guard] AUTH_ALLOW_DEMO cannot be true in production');
    }
    if (!data.SUPABASE_JWT_SECRET || data.SUPABASE_JWT_SECRET.trim() === '' || data.SUPABASE_JWT_SECRET.startsWith('demo-')) {
      throw new Error('[Boot Guard] SUPABASE_JWT_SECRET missing or using demo placeholder in production');
    }
    if (!data.SUPABASE_URL || data.SUPABASE_URL.startsWith('demo-') || data.SUPABASE_URL === 'https://demo.supabase.co') {
      throw new Error('[Boot Guard] SUPABASE_URL missing or using demo placeholder in production');
    }
    if (!data.SUPABASE_SERVICE_ROLE_KEY || data.SUPABASE_SERVICE_ROLE_KEY.startsWith('demo-')) {
      throw new Error('[Boot Guard] SUPABASE_SERVICE_ROLE_KEY missing or using demo placeholder in production');
    }
    if (!data.PAYPAL_PAYEE_MERCHANT_ID && !data.PAYPAL_PAYEE_EMAIL) {
      throw new Error('[Boot Guard] PAYPAL_PAYEE_MERCHANT_ID (or PAYPAL_PAYEE_EMAIL) must name the receiving PayPal account in production');
    }
    if (!data.PAYPAL_CLIENT_ID || data.PAYPAL_CLIENT_ID.startsWith('demo-')) {
      throw new Error('[Boot Guard] PAYPAL_CLIENT_ID missing or using demo placeholder in production');
    }
    if (!data.PAYPAL_CLIENT_SECRET || data.PAYPAL_CLIENT_SECRET.startsWith('demo-')) {
      throw new Error('[Boot Guard] PAYPAL_CLIENT_SECRET missing or using demo placeholder in production');
    }
    if (!data.PAYPAL_WEBHOOK_ID || data.PAYPAL_WEBHOOK_ID.startsWith('demo-')) {
      throw new Error('[Boot Guard] PAYPAL_WEBHOOK_ID missing or using demo placeholder in production');
    }
    if (!data.GEMINI_API_KEY || data.GEMINI_API_KEY.startsWith('demo-')) {
      throw new Error('[Boot Guard] GEMINI_API_KEY missing or using demo placeholder in production');
    }
    // The schema defaults CORS_ORIGIN to localhost, so "missing" must be caught by validating the VALUES: every
    // origin must be an explicit https origin (no wildcard, no localhost/loopback).
    const corsOrigins = (data.CORS_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    if (corsOrigins.length === 0 || corsOrigins.some((o) => o.includes('*'))) {
      throw new Error('[Boot Guard] CORS_ORIGIN missing or wildcard (*) in production');
    }
    for (const o of corsOrigins) {
      let u: URL;
      try {
        u = new URL(o);
      } catch {
        throw new Error(`[Boot Guard] CORS_ORIGIN contains an invalid origin in production: ${o}`);
      }
      if (u.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname)) {
        throw new Error('[Boot Guard] CORS_ORIGIN must list explicit https origins (no localhost) in production');
      }
    }
    if (!data.APP_BASE_URL || !data.APP_BASE_URL.startsWith('https://')) {
      throw new Error('[Boot Guard] APP_BASE_URL must use https:// in production');
    }
    if (data.STEP_UP_TEST_MODE === true) {
      throw new Error('[Boot Guard] STEP_UP_TEST_MODE cannot be true in production');
    }
    if (data.STEPUP_ENROLL_COOLDOWN_HOURS !== undefined && !(data.STEPUP_ENROLL_COOLDOWN_HOURS >= 1)) {
      throw new Error('[Boot Guard] STEPUP_ENROLL_COOLDOWN_HOURS must be at least 1 in production');
    }
    if (!data.STEP_UP_ENC_KEY || !/^[0-9a-fA-F]{64}$/.test(data.STEP_UP_ENC_KEY)) {
      throw new Error('[Boot Guard] STEP_UP_ENC_KEY must be 64 hex characters (32 bytes) in production');
    }
    let rpHost: string;
    try {
      rpHost = new URL(data.APP_BASE_URL).hostname;
    } catch {
      throw new Error('[Boot Guard] APP_BASE_URL is not a valid URL');
    }
    const rpId = (data.WEBAUTHN_RP_ID ?? rpHost).toLowerCase();
    if (rpId === 'localhost' || rpId.includes('*') || /^\d{1,3}(\.\d{1,3}){3}$/.test(rpId) || !(rpHost === rpId || rpHost.endsWith(`.${rpId}`))) {
      throw new Error('[Boot Guard] WEBAUTHN_RP_ID must be a real domain equal to (or a parent of) the APP_BASE_URL host in production');
    }
    for (const o of (data.WEBAUTHN_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      let u: URL;
      try { u = new URL(o); } catch { throw new Error(`[Boot Guard] WEBAUTHN_ORIGINS contains an invalid origin: ${o}`); }
      if (u.protocol !== 'https:' || !(u.hostname === rpId || u.hostname.endsWith(`.${rpId}`))) {
        throw new Error('[Boot Guard] WEBAUTHN_ORIGINS must be https origins under WEBAUTHN_RP_ID in production');
      }
    }
  }

  // Simulation and demo flags are strictly forced false in production regardless of environment
  const paypalSimulate = isProd ? false : (data.PAYPAL_SIMULATE ?? (data.NODE_ENV === 'test' || data.DEMO_MODE || data.PAYPAL_CLIENT_ID.startsWith('demo-')));
  const geminiSimulate = isProd ? false : (data.GEMINI_SIMULATE ?? (data.NODE_ENV === 'test' || data.DEMO_MODE || data.GEMINI_API_KEY.startsWith('demo-')));
  const placesLive = isProd ? (data.PLACES_LIVE ?? true) : (data.PLACES_LIVE ?? false);
  const authAllowDemo = isProd ? false : (data.AUTH_ALLOW_DEMO ?? (data.NODE_ENV === 'test' || data.DEMO_MODE || data.SUPABASE_ANON_KEY.startsWith('demo-')));

  let appUrl: URL;
  try {
    appUrl = new URL(data.APP_BASE_URL);
  } catch {
    throw new Error('[Config Error] APP_BASE_URL is not a valid URL');
  }
  const webauthnOrigins = (data.WEBAUTHN_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const stepUpTestMode = isProd ? false : (data.STEP_UP_TEST_MODE ?? false);

  return {
    ...data,
    STEP_UP_TEST_MODE: stepUpTestMode,
    STEP_UP_TEST_SECRET: data.STEP_UP_TEST_SECRET || crypto.randomBytes(32).toString('hex'),
    // Outside production an unset key becomes a random per-process key (enrolled TOTP secrets then do not
    // survive a restart, which is acceptable for local/dev data); production refuses to boot without one.
    STEP_UP_ENC_KEY: data.STEP_UP_ENC_KEY && /^[0-9a-fA-F]{64}$/.test(data.STEP_UP_ENC_KEY) ? data.STEP_UP_ENC_KEY : crypto.randomBytes(32).toString('hex'),
    WEBAUTHN_RP_ID: (data.WEBAUTHN_RP_ID ?? appUrl.hostname).toLowerCase(),
    WEBAUTHN_ORIGINS: webauthnOrigins.length > 0 ? webauthnOrigins : [appUrl.origin],
    STEPUP_ENROLL_COOLDOWN_HOURS: data.STEPUP_ENROLL_COOLDOWN_HOURS ?? (isProd ? 24 : 0),
    TRUST_PROXY_HOPS: data.TRUST_PROXY_HOPS ?? 1,
    // No hardcoded fallback: outside production an unset secret becomes a random per-process key
    // (production already refuses to boot without a real one above).
    SUPABASE_JWT_SECRET: data.SUPABASE_JWT_SECRET || crypto.randomBytes(32).toString('hex'),
    DEMO_MODE: isProd ? false : data.DEMO_MODE,
    PAYPAL_SIMULATE: paypalSimulate,
    GEMINI_SIMULATE: geminiSimulate,
    PLACES_LIVE: placesLive,
    AUTH_ALLOW_DEMO: authAllowDemo
  };
}

export const config = validateConfig();
