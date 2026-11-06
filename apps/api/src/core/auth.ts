import { DEMO_USER, DEFAULT_MEMBER_NAME, devTokenNameFor } from './demo.js';
import type { Request, Response, NextFunction } from 'express';
import { jwtVerify, SignJWT, decodeProtectedHeader, createRemoteJWKSet } from 'jose';
import { profilesRepo } from '../repos/profiles.js';
import { vaultRepo } from '../repos/vault.js';
import { erasedUsersRepo } from '../repos/erasedUsers.js';
import { isRemoteSupabaseEnabled } from './database.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleRouteError, ForbiddenError } from './errors.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
  requestId: string;
  /** `iat` of the session token, in seconds since the epoch (used to demand a fresh session for first enrollment). */
  sessionIssuedAt?: number;
}

export function getAuthReq(req: Request): AuthenticatedRequest {
  return req as unknown as AuthenticatedRequest;
}

export async function createDevToken(
  userId: string = DEMO_USER.id,
  email: string = DEMO_USER.email,
  name: string = devTokenNameFor(email)
): Promise<string> {
  if (config.NODE_ENV === 'production' || !config.AUTH_ALLOW_DEMO) {
    throw new ForbiddenError('Dev token generation forbidden in production');
  }
  return new SignJWT({
    sub: userId,
    email,
    user_metadata: { name },
    role: 'authenticated'
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .setAudience('authenticated')
    .sign(new TextEncoder().encode(config.SUPABASE_JWT_SECRET));
}

type KeyResolver = Parameters<typeof jwtVerify>[1];
let jwksOverride: KeyResolver | null = null;
let remoteJwks: KeyResolver | null = null;

/** Test hook: inject a JWKS resolver (e.g. jose.createLocalJWKSet) for asymmetric-token tests. */
export function __setJwksForTests(resolver: KeyResolver | null): void {
  jwksOverride = resolver;
}

/**
 * The ONE token verification path.
 *  - Allowed algorithms are pinned: HS256 (shared secret) and ES256/RS256 (Supabase asymmetric signing keys via JWKS).
 *    Anything else (including `none`) is rejected before any key is used.
 *  - audience must be "authenticated"; exp is enforced by jose.
 *  - when a real Supabase project is configured, the issuer must be `<SUPABASE_URL>/auth/v1`.
 * Throws on any failure; callers must treat every throw as 401 (fail closed).
 */
export async function verifyAccessToken(token: string): Promise<{ userId: string; userName?: string; issuedAt?: number }> {
  const header = decodeProtectedHeader(token);
  const alg = header.alg;
  const issuer = isRemoteSupabaseEnabled ? `${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1` : undefined;
  const common = { audience: 'authenticated', ...(issuer ? { issuer } : {}) };

  let payload;
  if (alg === 'HS256') {
    const secret = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
    ({ payload } = await jwtVerify(token, secret, { ...common, algorithms: ['HS256'] }));
  } else if (alg === 'ES256' || alg === 'RS256') {
    let resolver = jwksOverride ?? remoteJwks;
    if (!resolver) {
      if (!isRemoteSupabaseEnabled) throw new Error('Asymmetric tokens are not accepted without a configured Supabase project.');
      resolver = createRemoteJWKSet(new URL(`${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`));
      remoteJwks = resolver;
    }
    ({ payload } = await jwtVerify(token, resolver as never, { ...common, algorithms: ['ES256', 'RS256'] }));
  } else {
    throw new Error(`Unsupported token algorithm: ${String(alg)}`);
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('Token has no subject.');
  const meta = payload['user_metadata'] as Record<string, unknown> | undefined;
  const userName = (meta?.['name'] as string) || (payload['email'] as string)?.split('@')[0] || undefined;
  return { userId: payload.sub, userName, ...(typeof payload.iat === 'number' ? { issuedAt: payload.iat } : {}) };
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const reqId = (req.headers['x-request-id'] as string) || `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  (req as AuthenticatedRequest).requestId = reqId;

  try {
    const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      ok: false,
      requestId: reqId,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication required. Please sign in or pass a Bearer token.'
      }
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({
      ok: false,
      requestId: reqId,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Empty Bearer token provided.'
      }
    });
    return;
  }

  // Reject legacy magic string shortcuts immediately (fail closed)
  if (
    token === 'demo_token' ||
    token.startsWith('demo-token') ||
    token === 'demo-anon-key'
  ) {
    res.status(401).json({
      ok: false,
      requestId: reqId,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Legacy demo tokens have been deprecated. Use signed session tokens.'
      }
    });
    return;
  }

  let userId: string | null = null;
  let userName: string = DEFAULT_MEMBER_NAME;
  let issuedAt: number | undefined;

  try {
    const verified = await verifyAccessToken(token);
    userId = verified.userId;
    userName = verified.userName ?? userName;
    issuedAt = verified.issuedAt;
  } catch (err: unknown) {
    logger.warn('[AuthMiddleware] Token verification failed', {
      requestId: reqId,
      error: err instanceof Error ? err.message : String(err)
    });
    // Fail closed on ANY verification exception (expired, alg: none, bad signature, wrong aud, malformed)
    res.status(401).json({
      ok: false,
      requestId: reqId,
      error: {
        code: 'INVALID_TOKEN',
        message: 'JWT verification failed or token expired.'
      }
    });
    return;
  }

  if (!userId) {
    res.status(401).json({
      ok: false,
      requestId: reqId,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Could not resolve user identity from token.'
      }
    });
    return;
  }

  // 3b. Erased accounts are tombstoned: a still-valid JWT must NOT silently re-provision a fresh profile.
  if (await erasedUsersRepo.isErased(userId)) {
    res.status(401).json({
      ok: false,
      requestId: reqId,
      error: { code: 'ACCOUNT_ERASED', message: 'This account has been permanently erased.' }
    });
    return;
  }

  // 4. Ensure User Profile Exists (Create default if fresh signup with safe non-zero caps and zero fake balances)
  let profile = await profilesRepo.getById(userId);
  if (!profile) {
    profile = await profilesRepo.upsert({
      id: userId,
      name: userName,
      timezone: 'America/Los_Angeles',
      home_lat: 37.7749,
      home_lng: -122.4194,
      home_label: 'San Francisco, CA',
      max_distance_km: 8,
      guilt_free_cap_minor: 15000,
      per_action_cap_minor: 25000,
      weekly_cap_minor: 50000,
      currency: 'USD',
      opt_in_mood: true,
      opt_in_tracking: true,
      exploration_level: 'normal',
      created_at: new Date().toISOString()
    });

    await profilesRepo.upsertPreferences({
      user_id: userId,
      interests: ['cafes', 'gaming', 'sports'],
      social_pref: 'mixed',
      vibe_pref: 'quiet'
    });

    await vaultRepo.updatePocket({
      user_id: userId,
      kind: 'weekly',
      balance_minor: 0,
      target_minor: null,
      is_simulated: false
    });
  }

  (req as AuthenticatedRequest).userId = userId;
  if (issuedAt !== undefined) (req as AuthenticatedRequest).sessionIssuedAt = issuedAt;
  next();
  } catch (err: unknown) {
    handleRouteError(res, err, reqId);
  }
}
