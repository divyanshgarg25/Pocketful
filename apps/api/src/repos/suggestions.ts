import { localDb, supabaseClient, isRemoteSupabaseEnabled, handleSingleResult } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { Suggestion } from '../schemas/domain.js';

export class SuggestionsRepo {
  async createBatch(suggestions: Suggestion[]): Promise<Suggestion[]> {
    if (suggestions.length === 0) return [];
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('suggestions').insert(suggestions).select();
      if (error) throw new UpstreamError(`[SuggestionsRepo] Failed to create: ${error.message}`);
      return (data ?? []) as Suggestion[];
    }
    for (const s of suggestions) {
      localDb.suggestions.set(s.id, s);
    }
    return suggestions;
  }

  async getByPlanId(planId: string): Promise<Suggestion[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('suggestions').select('*').eq('plan_id', planId);
      if (error) throw new UpstreamError(`[SuggestionsRepo] Failed to fetch: ${error.message}`);
      return (data ?? []) as Suggestion[];
    }
    const result: Suggestion[] = [];
    for (const s of localDb.suggestions.values()) {
      if (s.plan_id === planId) {
        result.push(s);
      }
    }
    return result;
  }

  async getById(id: string, userId?: string): Promise<Suggestion | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient.from('suggestions').select('*').eq('id', id);
      if (userId) {
        query = query.eq('user_id', userId);
      }
      const { data, error } = await query.single();
      return handleSingleResult<Suggestion>(data as Suggestion, error, 'SuggestionsRepo');
    }
    const s = localDb.suggestions.get(id);
    if (!s) return null;
    if (userId && s.user_id !== userId) return null;
    return s;
  }

  async getByUserId(userId: string): Promise<Suggestion[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('suggestions')
        .select('*')
        .eq('user_id', userId)
        .order('shown_at', { ascending: false });
      if (error) throw new UpstreamError(`[SuggestionsRepo] Failed to fetch suggestions: ${error.message}`);
      return (data ?? []) as Suggestion[];
    }
    const result: Suggestion[] = [];
    for (const s of localDb.suggestions.values()) {
      if (s.user_id === userId) result.push(s);
    }
    return result.sort((a, b) => new Date(b.shown_at ?? '').getTime() - new Date(a.shown_at ?? '').getTime());
  }

  async getAcceptedForUser(userId: string, since?: string): Promise<Suggestion[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient
        .from('suggestions')
        .select('*')
        .eq('user_id', userId)
        .eq('outcome', 'accepted');
      if (since) {
        query = query.gte('decided_at', since);
      }
      const { data, error } = await query;
      if (error) throw new UpstreamError(`[SuggestionsRepo] Failed to fetch accepted: ${error.message}`);
      return (data ?? []) as Suggestion[];
    }
    const result: Suggestion[] = [];
    for (const s of localDb.suggestions.values()) {
      if (s.user_id === userId && s.outcome === 'accepted') {
        if (!since || (s.decided_at && s.decided_at >= since)) {
          result.push(s);
        }
      }
    }
    return result;
  }

  async updateOutcome(
    id: string,
    outcome: 'accepted' | 'modified' | 'rejected' | 'ignored',
    rejectReason?: 'too_far' | 'too_pricey' | 'not_my_vibe' | 'did_recently'
  ): Promise<Suggestion | null> {
    const payload = {
      outcome,
      reject_reason: rejectReason ?? null,
      decided_at: new Date().toISOString()
    };
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('suggestions')
        .update(payload)
        .eq('id', id)
        .select()
        .single();
      return handleSingleResult<Suggestion>(data as Suggestion, error, 'SuggestionsRepo');
    }
    const s = localDb.suggestions.get(id);
    if (!s) return null;
    const updated = { ...s, ...payload };
    localDb.suggestions.set(id, updated);
    return updated;
  }
}

export const suggestionsRepo = new SuggestionsRepo();
