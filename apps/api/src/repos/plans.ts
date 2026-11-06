import { localDb, supabaseClient, isRemoteSupabaseEnabled, handleSingleResult } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { Plan } from '../schemas/domain.js';

export class PlansRepo {
  async create(plan: Plan): Promise<Plan> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('plans').insert(plan).select().single();
      if (error || !data) throw new UpstreamError(`[PlansRepo] Failed to create: ${error?.message}`);
      return data as Plan;
    }
    localDb.plans.set(plan.id, plan);
    return plan;
  }

  async getById(id: string, userId?: string): Promise<Plan | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient.from('plans').select('*').eq('id', id);
      if (userId) {
        query = query.eq('user_id', userId);
      }
      const { data, error } = await query.single();
      return handleSingleResult<Plan>(data as Plan, error, 'PlansRepo');
    }
    const p = localDb.plans.get(id);
    if (!p) return null;
    if (userId && p.user_id !== userId) return null;
    return p;
  }

  async getByUserId(userId: string): Promise<Plan[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('plans')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw new UpstreamError(`[PlansRepo] Failed to fetch plans: ${error.message}`);
      return (data ?? []) as Plan[];
    }
    const plans: Plan[] = [];
    for (const p of localDb.plans.values()) {
      if (p.user_id === userId) plans.push(p);
    }
    return plans.sort((a, b) => new Date(b.created_at ?? '').getTime() - new Date(a.created_at ?? '').getTime());
  }

  async getLatestForUser(userId: string): Promise<Plan | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('plans')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw new UpstreamError(`[PlansRepo] Failed to fetch latest plan: ${error.message}`);
      }
      return data as Plan | null;
    }
    let latest: Plan | null = null;
    for (const p of localDb.plans.values()) {
      if (p.user_id === userId) {
        if (!latest || (p.created_at ?? '') > (latest.created_at ?? '')) {
          latest = p;
        }
      }
    }
    return latest;
  }

  async updateStatus(id: string, status: 'open' | 'accepted' | 'closed'): Promise<Plan | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('plans')
        .update({ status })
        .eq('id', id)
        .select()
        .single();
      return handleSingleResult<Plan>(data as Plan, error, 'PlansRepo');
    }
    const p = localDb.plans.get(id);
    if (!p) return null;
    const updated = { ...p, status };
    localDb.plans.set(id, updated);
    return updated;
  }
}

export const plansRepo = new PlansRepo();
