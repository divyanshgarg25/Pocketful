import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const ADMIN_URL = process.env.TEST_DB_ADMIN_URL ?? '';
export const PGRST_URL = process.env.TEST_PGRST_URL ?? '';
export const JWT_SECRET = process.env.PGRST_JWT_SECRET ?? 'test-jwt-secret-test-jwt-secret-1234567890';

if (!ADMIN_URL) throw new Error('TEST_DB_ADMIN_URL is required (run `npm run test:db`).');

export const pool = new pg.Pool({ connectionString: ADMIN_URL, max: 20 });

export async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
  return pool.query<T>(sql, params);
}

/** Run fn inside a transaction as a given DB role + JWT subject (mimics PostgREST). */
export async function asRole<T>(role: 'anon' | 'authenticated' | 'service_role', sub: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)`, [sub ?? '', role]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function signJwt(role: string, sub?: string): Promise<string> {
  return new SignJWT({ role, ...(sub ? { sub } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

export async function serviceClient(): Promise<SupabaseClient> {
  if (!PGRST_URL) throw new Error('TEST_PGRST_URL is required');
  return createClient(PGRST_URL, await signJwt('service_role'), { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function seedProfile(over: Partial<{ id: string; tz: string; currency: string; weekly: number; perAction: number }> = {}) {
  const id = over.id ?? randomUUID();
  await q(`insert into auth.users(id,email) values ($1,$2) on conflict do nothing`, [id, `${id}@t.test`]);
  await q(
    `insert into profiles(id,name,timezone,currency,weekly_cap_minor,per_action_cap_minor,guilt_free_cap_minor)
     values ($1,'T',$2,$3,$4,$5,1000)`,
    [id, over.tz ?? 'UTC', over.currency ?? 'USD', over.weekly ?? 50000, over.perAction ?? 25000]
  );
  return id;
}

export async function insertApproval(userId: string, o: Partial<{ id: string; status: string; action: string; money: number; amount: number; executedAt: string; payload: object }> = {}) {
  const id = o.id ?? randomUUID();
  await q(
    `insert into approvals(id,user_id,action_type,payload,preview,amount_minor,money_out_minor,status,idempotency_key,expires_at,executed_at)
     values ($1,$2,$3,$4,'p',$5,$6,$7,$8, now() + interval '1 hour', $9)`,
    [id, userId, o.action ?? 'vault_move', JSON.stringify(o.payload ?? {}), o.amount ?? o.money ?? 0, o.money ?? 0, o.status ?? 'pending', `k_${id}`, o.executedAt ?? null]
  );
  return id;
}
