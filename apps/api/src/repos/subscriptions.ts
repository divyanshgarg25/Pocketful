import { localDb, supabaseClient, isRemoteSupabaseEnabled, handleSingleResult } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { Subscription } from '../schemas/domain.js';

export class SubscriptionsRepo {
  async getByUserId(userId: string): Promise<Subscription[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .order('amount_minor', { ascending: false });
      if (error) throw new UpstreamError(`[SubscriptionsRepo] Failed to fetch: ${error.message}`);
      return (data ?? []) as Subscription[];
    }
    const subs: Subscription[] = [];
    for (const sub of localDb.subscriptions.values()) {
      if (sub.user_id === userId) {
        subs.push(sub);
      }
    }
    return subs.sort((a, b) => b.amount_minor - a.amount_minor);
  }

  async getById(id: string, userId?: string): Promise<Subscription | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient.from('subscriptions').select('*').eq('id', id);
      if (userId) {
        query = query.eq('user_id', userId);
      }
      const { data, error } = await query.single();
      return handleSingleResult<Subscription>(data as Subscription, error, 'SubscriptionsRepo');
    }
    const sub = localDb.subscriptions.get(id);
    if (!sub) return null;
    if (userId && sub.user_id !== userId) return null;
    return sub;
  }

  async getByPayPalSubId(paypalSubId: string): Promise<Subscription | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('subscriptions')
        .select('*')
        .eq('paypal_subscription_id', paypalSubId)
        .maybeSingle();
      if (error) throw new UpstreamError(`[SubscriptionsRepo] Failed to fetch by paypal id: ${error.message}`);
      return data as Subscription | null;
    }
    for (const sub of localDb.subscriptions.values()) {
      if (sub.paypal_subscription_id === paypalSubId) {
        return sub;
      }
    }
    return null;
  }

  async updateStatus(id: string, status: 'active' | 'cancel_pending' | 'cancelled'): Promise<Subscription | null> {
    const cancelled_at = status === 'cancelled' ? new Date().toISOString() : undefined;
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('subscriptions')
        .update({ status })
        .eq('id', id)
        .select()
        .single();
      return handleSingleResult<Subscription>(data as Subscription, error, 'SubscriptionsRepo');
    }
    const sub = localDb.subscriptions.get(id);
    if (!sub) return null;
    const updated = { ...sub, status, ...(cancelled_at ? { cancelled_at } : {}) };
    localDb.subscriptions.set(id, updated);
    return updated;
  }

  async snoozeGhost(id: string, until: Date): Promise<Subscription | null> {
    const iso = until.toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('subscriptions')
        .update({ ghost_snoozed_until: iso })
        .eq('id', id)
        .select()
        .single();
      return handleSingleResult<Subscription>(data as Subscription, error, 'SubscriptionsRepo');
    }
    const sub = localDb.subscriptions.get(id);
    if (!sub) return null;
    const updated = { ...sub, ghost_snoozed_until: iso };
    localDb.subscriptions.set(id, updated);
    return updated;
  }
}

export const subscriptionsRepo = new SubscriptionsRepo();
