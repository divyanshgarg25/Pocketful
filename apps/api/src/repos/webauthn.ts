import crypto from 'crypto';
import { localDb, supabaseClient, isRemoteSupabaseEnabled, type LocalWebAuthnCred } from '../core/database.js';
import { ConflictError, UpstreamError } from '../core/errors.js';
import { withUserLock } from '../core/mutex.js';

export type WebAuthnCredentialRow = LocalWebAuthnCred;
export type ChallengePurpose = 'register' | 'enroll';

export const CEREMONY_TTL_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS_PER_USER = 10;

type NewCredential = Omit<WebAuthnCredentialRow, 'id' | 'created_at' | 'last_used_at'>;

/** Passkey storage. Public keys only: private keys never leave the authenticator. Service-role access only. */
export class WebAuthnRepo {
  async list(userId: string): Promise<WebAuthnCredentialRow[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('webauthn_credentials')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
      if (error) throw new UpstreamError(`[WebAuthn] read failed: ${error.message}`);
      return (data ?? []) as WebAuthnCredentialRow[];
    }
    return [...localDb.webauthn_credentials.values()]
      .filter((c) => c.user_id === userId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((c) => ({ ...c }));
  }

  /** Always scoped to the user: a credential id belonging to someone else is simply "not found". */
  async get(userId: string, credentialId: string): Promise<WebAuthnCredentialRow | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('webauthn_credentials')
        .select('*')
        .eq('user_id', userId)
        .eq('credential_id', credentialId)
        .maybeSingle();
      if (error) throw new UpstreamError(`[WebAuthn] read failed: ${error.message}`);
      return (data as WebAuthnCredentialRow) ?? null;
    }
    const c = localDb.webauthn_credentials.get(credentialId);
    return c && c.user_id === userId ? { ...c } : null;
  }

  async create(input: NewCredential): Promise<WebAuthnCredentialRow> {
    const row: WebAuthnCredentialRow = {
      ...input,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      last_used_at: null
    };
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('webauthn_credentials').insert(row).select('*').single();
      if (error) {
        if (error.code === '23505') throw new ConflictError('This passkey is already registered.');
        throw new UpstreamError(`[WebAuthn] write failed: ${error.message}`);
      }
      return data as WebAuthnCredentialRow;
    }
    if (localDb.webauthn_credentials.has(row.credential_id)) throw new ConflictError('This passkey is already registered.');
    localDb.webauthn_credentials.set(row.credential_id, row);
    return { ...row };
  }

  /**
   * Compare-and-swap on the previous counter so two concurrent assertions cannot both succeed with the same
   * (cloned) credential state. Returns false if the stored counter moved in the meantime.
   *
   * The counter may only move FORWARD (new > previous). The one exception is an authenticator that never counts and
   * always reports 0 (0 -> 0). A sideways or backwards move is the classic cloned-authenticator signal and is refused.
   */
  async recordUse(userId: string, credentialId: string, previousCounter: number, newCounter: number): Promise<boolean> {
    const forward = newCounter > previousCounter;
    const nonCounting = newCounter === 0 && previousCounter === 0;
    if (!forward && !nonCounting) return false;
    const now = new Date().toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('webauthn_credentials')
        .update({ counter: newCounter, last_used_at: now })
        .eq('user_id', userId)
        .eq('credential_id', credentialId)
        .eq('counter', previousCounter) // the compare-and-swap: only the first writer from this state wins
        .select('id');
      if (error) throw new UpstreamError(`[WebAuthn] write failed: ${error.message}`);
      return (data ?? []).length === 1;
    }
    return withUserLock(userId, () => {
      const c = localDb.webauthn_credentials.get(credentialId);
      if (!c || c.user_id !== userId || c.counter !== previousCounter) return false;
      c.counter = newCounter;
      c.last_used_at = now;
      return true;
    });
  }

  /** Deletes ONE of the user's own passkeys by its row id. Returns false if there is no such passkey for this user. */
  async remove(userId: string, id: string): Promise<boolean> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('webauthn_credentials').delete().eq('user_id', userId).eq('id', id).select('id');
      if (error) throw new UpstreamError(`[WebAuthn] write failed: ${error.message}`);
      return (data ?? []).length === 1;
    }
    for (const [k, c] of localDb.webauthn_credentials) {
      if (c.id === id && c.user_id === userId) {
        localDb.webauthn_credentials.delete(k);
        return true;
      }
    }
    return false;
  }

  // ---- ceremony challenges (single-use, 5 minutes, one live per user+purpose) ---------------------------------

  async putChallenge(userId: string, purpose: ChallengePurpose, challenge: string): Promise<void> {
    const expires_at = new Date(Date.now() + CEREMONY_TTL_MS).toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient
        .from('webauthn_challenges')
        .upsert({ user_id: userId, purpose, challenge, expires_at, created_at: new Date().toISOString() }, { onConflict: 'user_id,purpose' });
      if (error) throw new UpstreamError(`[WebAuthn] write failed: ${error.message}`);
      return;
    }
    localDb.webauthn_challenges.set(`${userId}:${purpose}`, { user_id: userId, purpose, challenge, expires_at });
  }

  /** Atomically deletes and returns the live challenge, or null if absent/expired. A challenge can never be used twice. */
  async consumeChallenge(userId: string, purpose: ChallengePurpose): Promise<string | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('webauthn_challenges')
        .delete()
        .eq('user_id', userId)
        .eq('purpose', purpose)
        .select('challenge, expires_at');
      if (error) throw new UpstreamError(`[WebAuthn] write failed: ${error.message}`);
      const row = (data ?? [])[0] as { challenge: string; expires_at: string } | undefined;
      return row && new Date(row.expires_at).getTime() > Date.now() ? row.challenge : null;
    }
    const key = `${userId}:${purpose}`;
    const row = localDb.webauthn_challenges.get(key);
    localDb.webauthn_challenges.delete(key);
    return row && new Date(row.expires_at).getTime() > Date.now() ? row.challenge : null;
  }
}

export const webauthnRepo = new WebAuthnRepo();
