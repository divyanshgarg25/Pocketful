import { localDb, supabaseClient, isRemoteSupabaseEnabled, handleSingleResult } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { Vault, Pocket, MoodCheckin } from '../schemas/domain.js';
import { getIsoWeekKey } from '../jobs/runner.js';
import { profilesRepo } from './profiles.js';
import crypto from 'crypto';

export class VaultRepo {
  async getVault(userId: string): Promise<Vault | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('vault').select('*').eq('user_id', userId).single();
      return handleSingleResult<Vault>(data as Vault, error, 'VaultRepo');
    }
    return localDb.vault.get(userId) ?? null;
  }

  async updateVault(vault: Vault): Promise<Vault> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('vault').upsert(vault).select().single();
      if (error || !data) throw new UpstreamError(`[VaultRepo] Failed to update vault: ${error?.message}`);
      return data as Vault;
    }
    localDb.vault.set(vault.user_id, vault);
    return vault;
  }

  /**
   * Atomically move leftover weekly fun money into the vault. Debit and credit happen in one
   * transaction (Postgres RPC) or one synchronous critical section (local driver): money cannot vanish.
   */
  async moveWeeklyToVault(
    userId: string,
    action: 'lock_in' | 'roll_over',
    amountMinor: number
  ): Promise<{ ok: true; vault: Vault } | { ok: false; code: string; balanceMinor?: number }> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.rpc('move_weekly_to_vault', {
        p_user: userId,
        p_action: action,
        p_amount: amountMinor
      });
      if (error) throw new UpstreamError(`[VaultRepo] move_weekly_to_vault failed: ${error.message}`);
      const r = data as { ok: boolean; code?: string; balance_minor?: number; vault?: Vault };
      return r.ok && r.vault ? { ok: true, vault: r.vault } : { ok: false, code: r.code ?? 'FAILED', balanceMinor: r.balance_minor };
    }
    // Local driver: no awaits between read and write, so this section cannot interleave.
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) return { ok: false, code: 'BAD_AMOUNT' };
    const key = `${userId}:weekly`;
    const pocket = localDb.pockets.get(key);
    if (!pocket || pocket.balance_minor < amountMinor) {
      return { ok: false, code: 'INSUFFICIENT', balanceMinor: pocket?.balance_minor ?? 0 };
    }
    const cur = localDb.vault.get(userId) ?? { user_id: userId, goal_balance_minor: 0, rollover_balance_minor: 0, is_simulated: true };
    const vault: Vault = {
      ...cur,
      goal_balance_minor: cur.goal_balance_minor + (action === 'lock_in' ? amountMinor : 0),
      rollover_balance_minor: cur.rollover_balance_minor + (action === 'roll_over' ? amountMinor : 0)
    };
    localDb.pockets.set(key, { ...pocket, balance_minor: pocket.balance_minor - amountMinor });
    localDb.vault.set(userId, vault);
    return { ok: true, vault };
  }

  /** Atomically move money between pockets; a missing destination pocket is created, never silently skipped. */
  async movePocketBalance(
    userId: string,
    from: 'weekly' | 'holiday' | 'getaway',
    to: 'weekly' | 'holiday' | 'getaway',
    amountMinor: number
  ): Promise<{ ok: true } | { ok: false; code: string; balanceMinor?: number }> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.rpc('move_pocket_balance', {
        p_user: userId,
        p_from: from,
        p_to: to,
        p_amount: amountMinor
      });
      if (error) throw new UpstreamError(`[VaultRepo] move_pocket_balance failed: ${error.message}`);
      const r = data as { ok: boolean; code?: string; balance_minor?: number };
      return r.ok ? { ok: true } : { ok: false, code: r.code ?? 'FAILED', balanceMinor: r.balance_minor };
    }
    if (!Number.isInteger(amountMinor) || amountMinor <= 0 || from === to) return { ok: false, code: 'BAD_ARGS' };
    const src = localDb.pockets.get(`${userId}:${from}`);
    if (!src || src.balance_minor < amountMinor) return { ok: false, code: 'INSUFFICIENT', balanceMinor: src?.balance_minor ?? 0 };
    const dst = localDb.pockets.get(`${userId}:${to}`) ?? { user_id: userId, kind: to, balance_minor: 0, target_minor: null, is_simulated: src.is_simulated };
    localDb.pockets.set(`${userId}:${from}`, { ...src, balance_minor: src.balance_minor - amountMinor });
    localDb.pockets.set(`${userId}:${to}`, { ...dst, balance_minor: dst.balance_minor + amountMinor });
    return { ok: true };
  }

  async getPockets(userId: string): Promise<Pocket[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('pockets').select('*').eq('user_id', userId);
      if (error) throw new UpstreamError(`[VaultRepo] Failed to fetch pockets: ${error.message}`);
      return (data ?? []) as Pocket[];
    }
    const result: Pocket[] = [];
    const prefix = `${userId}:`;
    for (const [key, p] of localDb.pockets.entries()) {
      if (key.startsWith(prefix)) {
        result.push(p);
      }
    }
    return result;
  }

  async getPocket(userId: string, kind: 'weekly' | 'holiday' | 'getaway'): Promise<Pocket | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('pockets')
        .select('*')
        .eq('user_id', userId)
        .eq('kind', kind)
        .single();
      return handleSingleResult<Pocket>(data as Pocket, error, 'VaultRepo');
    }
    return localDb.pockets.get(`${userId}:${kind}`) ?? null;
  }

  async updatePocket(pocket: Pocket): Promise<Pocket> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('pockets')
        .upsert(pocket, { onConflict: 'user_id, kind' })
        .select()
        .single();
      if (error || !data) throw new UpstreamError(`[VaultRepo] Failed to update pocket: ${error?.message}`);
      return data as Pocket;
    }
    localDb.pockets.set(`${pocket.user_id}:${pocket.kind}`, pocket);
    return pocket;
  }

  async saveMoodCheckin(userId: string, level: 'drained' | 'okay' | 'great'): Promise<MoodCheckin> {
    // The week is the user's LOCAL ISO week (a UTC week puts an Auckland Monday morning in the previous week).
    const profile = await profilesRepo.getById(userId);
    const week = getIsoWeekKey(new Date(), profile?.timezone || 'UTC');
    const checkin: MoodCheckin = {
      id: crypto.randomUUID(),
      user_id: userId,
      week,
      level
    };

    if (isRemoteSupabaseEnabled && supabaseClient) {
      // `id` is excluded from the conflict update by design: an existing week keeps its original id.
      const { data: existing, error: readErr } = await supabaseClient
        .from('mood_checkins').select('id').eq('user_id', userId).eq('week', week).maybeSingle();
      if (readErr) throw new UpstreamError(`[VaultRepo] Failed to read mood checkin: ${readErr.message}`);
      const row: MoodCheckin = { ...checkin, id: (existing?.id as string | undefined) ?? checkin.id };
      const { data, error } = await supabaseClient
        .from('mood_checkins').upsert(row, { onConflict: 'user_id,week' }).select().single();
      if (error || !data) throw new UpstreamError(`[VaultRepo] Failed to save mood checkin: ${error?.message}`);
      return data as MoodCheckin;
    }
    const prior = localDb.mood_checkins.get(`${userId}:${week}`);
    const saved: MoodCheckin = { ...checkin, id: prior?.id ?? checkin.id };
    localDb.mood_checkins.set(`${userId}:${week}`, saved);
    return saved;
  }

  async getLatestMoodCheckin(userId: string): Promise<MoodCheckin | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('mood_checkins')
        .select('*')
        .eq('user_id', userId)
        .order('week', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new UpstreamError(`[VaultRepo] Failed to fetch latest mood checkin: ${error.message}`);
      return data as MoodCheckin | null;
    }
    let latest: MoodCheckin | null = null;
    for (const m of localDb.mood_checkins.values()) {
      if (m.user_id === userId) {
        if (!latest || m.week > latest.week) {
          latest = m;
        }
      }
    }
    return latest;
  }
}

export const vaultRepo = new VaultRepo();
