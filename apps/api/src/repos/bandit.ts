import { localDb, supabaseClient, isRemoteSupabaseEnabled } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { BanditState, LearningEvent } from '../schemas/domain.js';

export class BanditRepo {
  async getBanditStateForUser(userId: string): Promise<Map<string, BanditState>> {
    const map = new Map<string, BanditState>();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('bandit_state').select('*').eq('user_id', userId);
      if (error) throw new UpstreamError(`[BanditRepo] Failed to fetch bandit state: ${error.message}`);
      for (const row of data ?? []) {
        map.set(`${row.feature}:${row.value}`, row as BanditState);
      }
      return map;
    }
    const prefix = `${userId}:`;
    for (const [key, state] of localDb.bandit_state.entries()) {
      if (key.startsWith(prefix)) {
        const featureKey = `${state.feature}:${state.value}`;
        map.set(featureKey, state);
      }
    }
    return map;
  }

  async saveBanditState(state: BanditState): Promise<void> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient
        .from('bandit_state')
        .upsert(state, { onConflict: 'user_id, feature, value' });
      if (error) throw new UpstreamError(`[BanditRepo] Failed to save bandit state: ${error.message}`);
      return;
    }
    const key = `${state.user_id}:${state.feature}:${state.value}`;
    localDb.bandit_state.set(key, state);
  }

  async logEvent(event: LearningEvent): Promise<LearningEvent> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('learning_events').insert(event).select().single();
      if (error || !data) throw new UpstreamError(`[BanditRepo] Failed to log learning event: ${error?.message}`);
      return data as LearningEvent;
    }
    localDb.learning_events.push(event);
    return event;
  }

  async getEventsForUser(userId: string, includeReverted = false): Promise<LearningEvent[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient
        .from('learning_events')
        .select('*')
        .eq('user_id', userId);
      if (!includeReverted) {
        query = query.eq('reverted', false);
      }
      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw new UpstreamError(`[BanditRepo] Failed to fetch events: ${error.message}`);
      return (data ?? []) as LearningEvent[];
    }
    return localDb.learning_events
      .filter((e) => e.user_id === userId && (includeReverted || !e.reverted))
      .sort((a, b) => new Date(b.created_at ?? '').getTime() - new Date(a.created_at ?? '').getTime());
  }

  async revertEventsForFeature(userId: string, feature: string, value?: string): Promise<void> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      // In remote Supabase, fetch and mark reverted
      const { data } = await supabaseClient
        .from('learning_events')
        .select('id, features')
        .eq('user_id', userId)
        .eq('reverted', false);
      const toRevert: string[] = [];
      for (const row of data ?? []) {
        if (row.features && row.features[feature] !== undefined) {
          if (!value || row.features[feature] === value) {
            toRevert.push(row.id);
          }
        }
      }
      if (toRevert.length > 0) {
        await supabaseClient.from('learning_events').update({ reverted: true }).in('id', toRevert);
      }
      return;
    }

    for (const e of localDb.learning_events) {
      if (e.user_id === userId && !e.reverted) {
        if (e.features[feature] !== undefined) {
          if (!value || e.features[feature] === value) {
            e.reverted = true;
          }
        }
      }
    }
  }

  async resetAllForUser(userId: string): Promise<void> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      await supabaseClient.from('learning_events').update({ reverted: true }).eq('user_id', userId);
      await supabaseClient.from('bandit_state').delete().eq('user_id', userId);
      return;
    }
    for (const e of localDb.learning_events) {
      if (e.user_id === userId) {
        e.reverted = true;
      }
    }
    const prefix = `${userId}:`;
    for (const k of Array.from(localDb.bandit_state.keys())) {
      if (k.startsWith(prefix)) {
        localDb.bandit_state.delete(k);
      }
    }
  }
}

export const banditRepo = new BanditRepo();
