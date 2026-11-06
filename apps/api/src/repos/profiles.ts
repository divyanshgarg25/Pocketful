import { localDb, supabaseClient, isRemoteSupabaseEnabled, handleSingleResult } from '../core/database.js';
import { UpstreamError, ValidationError } from '../core/errors.js';
import { isSupportedCurrency } from '../core/currency.js';
import type { Profile, Preferences } from '../schemas/domain.js';

export class ProfilesRepo {
  async getById(id: string): Promise<Profile | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('profiles').select('*').eq('id', id).single();
      return handleSingleResult<Profile>(data as Profile, error, 'ProfilesRepo');
    }
    return localDb.profiles.get(id) ?? null;
  }

  /**
   * Calls `fn` with each page of profiles (keyset pagination by id, stable even if rows are added meanwhile) and
   * returns the total number visited. Unpaged selects are silently truncated by PostgREST's max-rows, so anything that
   * must see EVERY user goes through here.
   */
  async forEachPage(pageSize: number, fn: (page: Profile[]) => Promise<void>): Promise<number> {
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new ValidationError('pageSize must be a positive integer');
    let total = 0;
    let lastId: string | null = null;
    for (;;) {
      let page: Profile[];
      if (isRemoteSupabaseEnabled && supabaseClient) {
        let query = supabaseClient.from('profiles').select('*').order('id', { ascending: true }).limit(pageSize);
        if (lastId !== null) query = query.gt('id', lastId);
        const { data, error } = await query;
        if (error) throw new UpstreamError(`[ProfilesRepo] Failed to fetch page: ${error.message}`);
        page = (data ?? []) as Profile[];
      } else {
        page = Array.from(localDb.profiles.values())
          .filter((p) => lastId === null || p.id > lastId)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, pageSize);
      }
      if (page.length === 0) break;
      await fn(page);
      total += page.length;
      lastId = page[page.length - 1]!.id;
      if (page.length < pageSize) break;
    }
    return total;
  }

  async getAll(): Promise<Profile[]> {
    const all: Profile[] = [];
    await this.forEachPage(200, async (page) => {
      all.push(...page);
    });
    return all;
  }

  async upsert(profile: Profile): Promise<Profile> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('profiles').upsert(profile).select().single();
      if (error || !data) throw new UpstreamError(`[ProfilesRepo] Failed to upsert profile: ${error?.message}`);
      return data as Profile;
    }
    // Parity with chk_profiles_currency in Postgres.
    if (!isSupportedCurrency(profile.currency)) throw new ValidationError(`Unsupported currency: ${String(profile.currency)}`);
    localDb.profiles.set(profile.id, profile);
    return profile;
  }

  async getPreferences(userId: string): Promise<Preferences | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('preferences').select('*').eq('user_id', userId).single();
      return handleSingleResult<Preferences>(data as Preferences, error, 'ProfilesRepo');
    }
    return localDb.preferences.get(userId) ?? null;
  }

  async upsertPreferences(preferences: Preferences): Promise<Preferences> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('preferences').upsert(preferences).select().single();
      if (error || !data) throw new UpstreamError(`[ProfilesRepo] Failed to upsert preferences: ${error?.message}`);
      return data as Preferences;
    }
    localDb.preferences.set(preferences.user_id, preferences);
    return preferences;
  }

  async eraseUser(userId: string): Promise<boolean> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient.rpc('erase_user', { target_user_id: userId });
      if (error) throw new UpstreamError(`[ProfilesRepo] Failed to erase user: ${error.message}`);
      return true;
    }
    // Collect identifiers of this user's groups/payments BEFORE deleting them (webhook payload matching).
    const refIds: string[] = [userId];
    for (const g of localDb.groups.values()) {
      if (g.organizer_id !== userId) continue;
      refIds.push(g.id);
      for (const p of localDb.group_payments.values()) if (p.group_id === g.id) refIds.push(p.id);
    }
    for (const [k, ev] of localDb.webhook_events) {
      const body = JSON.stringify(ev.payload ?? {});
      if (refIds.some((id) => body.includes(id))) localDb.webhook_events.delete(k);
    }
    for (const [k, r] of localDb.job_runs) {
      if (r.job.includes(userId) || (r.lease_key ?? '').includes(userId)) localDb.job_runs.delete(k);
    }
    // Anonymise (never delete) audit rows, identical to erase_user() in SQL.
    for (const entry of localDb.audit_log) {
      if (entry.user_id === userId) {
        entry.params = { redacted: true };
        entry.result = { redacted: true };
        entry.user_id = null;
      }
    }
    // Step-up factors cascade from profiles in SQL (on delete cascade); mirror that here.
    localDb.step_up.delete(userId);
    // ON DELETE SET NULL: the settlement ledger keeps its rows (financial history) but loses the pseudonymous link.
    for (const row of localDb.settlements.values()) {
      if (row.organizer_id === userId) row.organizer_id = null;
    }
    for (const [k, c] of localDb.webauthn_credentials) {
      if (c.user_id === userId) localDb.webauthn_credentials.delete(k);
    }
    for (const [k, c] of localDb.webauthn_challenges) {
      if (c.user_id === userId) localDb.webauthn_challenges.delete(k);
    }
    // security_notifications cascades from profiles in SQL too.
    localDb.security_notifications = localDb.security_notifications.filter((n) => n.user_id !== userId);
    localDb.profiles.delete(userId);
    localDb.preferences.delete(userId);
    localDb.vault.delete(userId);
    localDb.pockets.delete(`${userId}:weekly`);
    localDb.pockets.delete(`${userId}:holiday`);
    localDb.pockets.delete(`${userId}:getaway`);
    localDb.nudge_settings.delete(userId);
    for (const [k, s] of localDb.subscriptions) {
      if (s.user_id === userId) localDb.subscriptions.delete(k);
    }
    for (const [k, p] of localDb.plans) {
      if (p.user_id === userId) localDb.plans.delete(k);
    }
    for (const [k, s] of localDb.suggestions) {
      if (s.user_id === userId) localDb.suggestions.delete(k);
    }
    for (const [k, t] of localDb.transactions) {
      if (t.user_id === userId) localDb.transactions.delete(k);
    }
    for (const [k, a] of localDb.approvals) {
      if (a.user_id === userId) localDb.approvals.delete(k);
    }
    for (const [k, g] of localDb.groups) {
      if (g.organizer_id === userId) {
        for (const [pk, p] of localDb.group_payments) {
          if (p.group_id === g.id) localDb.group_payments.delete(pk);
        }
        localDb.groups.delete(k);
      }
    }
    for (const [k, m] of localDb.mood_checkins) {
      if (m.user_id === userId) localDb.mood_checkins.delete(k);
    }
    localDb.chat_messages = localDb.chat_messages.filter((m) => m.user_id !== userId);
    localDb.learning_events = localDb.learning_events.filter((e) => e.user_id !== userId);
    for (const k of Array.from(localDb.bandit_state.keys())) {
      if (k.startsWith(`${userId}:`)) {
        localDb.bandit_state.delete(k);
      }
    }
    for (const [k, h] of localDb.habits) {
      if (h.user_id === userId) localDb.habits.delete(k);
    }
    for (const [k, o] of localDb.occasions) {
      if (o.user_id === userId) localDb.occasions.delete(k);
    }
    for (const [k, l] of localDb.user_leave_days) {
      if (l.user_id === userId) localDb.user_leave_days.delete(k);
    }
    if (!localDb.erased_users.has(userId)) localDb.erased_users.set(userId, { erased_at: new Date().toISOString() });
    return true;
  }
}

export const profilesRepo = new ProfilesRepo();
