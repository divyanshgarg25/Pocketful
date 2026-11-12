import { logError } from './log';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { demoIdentity } from './demo';
import { sessionStore, isTokenExpired, type SessionUser } from './sessionStore';

export type { SessionUser };
export { isTokenExpired };

const rawSupabaseUrl = (import.meta.env['VITE_SUPABASE_URL'] as string) || '';
const SUPABASE_URL = rawSupabaseUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = (import.meta.env['VITE_SUPABASE_ANON_KEY'] as string) || '';

const rawApiUrl = (import.meta.env['VITE_API_URL'] as string) || 'http://localhost:3001';
const API_BASE = rawApiUrl.startsWith('http://') || rawApiUrl.startsWith('https://')
  ? rawApiUrl
  : `https://${rawApiUrl}`;

export const isRemoteSupabaseConfigured =
  Boolean(SUPABASE_URL) &&
  Boolean(SUPABASE_ANON_KEY) &&
  SUPABASE_URL !== 'https://demo.supabase.co' &&
  SUPABASE_ANON_KEY !== 'demo-anon-key' &&
  !SUPABASE_ANON_KEY.startsWith('demo-');

export const supabase: SupabaseClient | null = isRemoteSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // Keep Supabase's session (including its long-lived refresh token) in the same tab-scoped store as ours,
      // not in the default localStorage.
      auth: { storage: sessionStore.storage, persistSession: true, autoRefreshToken: true }
    })
  : null;

export const getStoredToken = (): string | null => sessionStore.getToken();
export const getStoredUser = (): SessionUser | null => sessionStore.getUser();
export const setStoredSession = (token: string, user: SessionUser): void => sessionStore.set(token, user);
export const clearStoredSession = (): void => sessionStore.clear();

/**
 * Sign In with Email & Password via Supabase Auth
 */
export async function signIn(email: string, pass: string): Promise<{ token: string; user: SessionUser }> {
  if (!supabase) {
    throw new Error('Supabase authentication is not configured. Please configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: pass
  });
  if (error || !data.session || !data.user) {
    throw new Error(error?.message || 'Failed to sign in via Supabase Auth.');
  }
  const user: SessionUser = {
    id: data.user.id,
    email: data.user.email ?? email,
    name: (data.user.user_metadata?.['name'] as string) || (data.user.email?.split('@')[0] ?? 'User')
  };
  setStoredSession(data.session.access_token, user);
  return { token: data.session.access_token, user };
}

/**
 * Sign Up with Email, Password & Name via Supabase Auth
 */
export async function signUp(email: string, pass: string, name: string): Promise<{ token: string; user: SessionUser }> {
  if (!supabase) {
    throw new Error('Supabase authentication is not configured. Please configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password: pass,
    options: { data: { name } }
  });
  if (error || !data.user) {
    throw new Error(error?.message || 'Failed to create account.');
  }
  if (!data.session) {
    throw new Error('Confirmation email sent. Please verify your email before signing in.');
  }
  const user: SessionUser = {
    id: data.user.id,
    email: data.user.email ?? email,
    name
  };
  setStoredSession(data.session.access_token, user);
  return { token: data.session.access_token, user };
}

/**
 * Quick-start demo sign in (dev-only signed token issued by backend)
 */
export async function signInDemo(): Promise<{ token: string; user: SessionUser }> {
  if (!demoIdentity) throw new Error('Demo sign-in is not available in this build.');
  const res = await fetch(`${API_BASE}/api/auth/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: demoIdentity.id, email: demoIdentity.email, name: demoIdentity.name })
  });

  if (!res.ok) {
    throw new Error('Demo authentication is disabled in this environment.');
  }

  const json = await res.json();
  const token = json.data.token;
  const user: SessionUser = json.data.user;
  setStoredSession(token, user);
  return { token, user };
}

/**
 * Sign Out
 */
export async function signOut(): Promise<void> {
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      logError('Supabase signOut error:', e);
    }
  }
  clearStoredSession();
}
