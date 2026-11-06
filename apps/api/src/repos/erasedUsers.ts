import { localDb, supabaseClient, isRemoteSupabaseEnabled } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';

/** Tombstones for erased accounts. A still-valid JWT for a tombstoned user must never re-provision a profile. */
export class ErasedUsersRepo {
  private positiveCache = new Set<string>(); // tombstones are permanent; only positives are cached

  async isErased(userId: string): Promise<boolean> {
    if (this.positiveCache.has(userId)) return true;
    let erased: boolean;
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('erased_users').select('user_id').eq('user_id', userId).maybeSingle();
      if (error) throw new UpstreamError(`[ErasedUsersRepo] Failed to check tombstone: ${error.message}`);
      erased = Boolean(data);
    } else {
      erased = localDb.erased_users.has(userId);
    }
    if (erased) this.positiveCache.add(userId);
    return erased;
  }

  async markAuthDeleted(userId: string): Promise<void> {
    const now = new Date().toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient.from('erased_users').update({ auth_deleted_at: now }).eq('user_id', userId);
      if (error) throw new UpstreamError(`[ErasedUsersRepo] Failed to mark auth identity deleted: ${error.message}`);
      return;
    }
    const t = localDb.erased_users.get(userId);
    if (t) t.auth_deleted_at = now;
  }

  /** Tombstones whose Supabase auth identity still exists (erase succeeded but auth delete failed). */
  async listPendingAuthDeletes(limit = 100): Promise<string[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('erased_users').select('user_id').is('auth_deleted_at', null).limit(limit);
      if (error) throw new UpstreamError(`[ErasedUsersRepo] Failed to list pending auth deletes: ${error.message}`);
      return (data ?? []).map((r) => r.user_id as string);
    }
    return [...localDb.erased_users.entries()].filter(([, t]) => !t.auth_deleted_at).map(([id]) => id).slice(0, limit);
  }

  /** Test helper for the local driver only. */
  resetCacheForTests(): void {
    this.positiveCache.clear();
  }
}

export const erasedUsersRepo = new ErasedUsersRepo();
