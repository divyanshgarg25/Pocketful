import { localDb, supabaseClient, isRemoteSupabaseEnabled, handleSingleResult } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { Transaction } from '../schemas/domain.js';

export class TransactionsRepo {
  async getByUserId(userId: string): Promise<Transaction[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .order('occurred_at', { ascending: false });
      if (error) throw new UpstreamError(`[TransactionsRepo] Failed to fetch: ${error.message}`);
      return (data ?? []) as Transaction[];
    }
    const txns: Transaction[] = [];
    for (const t of localDb.transactions.values()) {
      if (t.user_id === userId) {
        txns.push(t);
      }
    }
    return txns.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  }

  async getById(id: string, userId?: string): Promise<Transaction | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient.from('transactions').select('*').eq('id', id);
      if (userId) {
        query = query.eq('user_id', userId);
      }
      const { data, error } = await query.single();
      return handleSingleResult<Transaction>(data as Transaction, error, 'TransactionsRepo');
    }
    const t = localDb.transactions.get(id);
    if (!t) return null;
    if (userId && t.user_id !== userId) return null;
    return t;
  }

  async insert(txn: Transaction): Promise<Transaction> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('transactions').insert(txn).select().single();
      if (error || !data) throw new UpstreamError(`[TransactionsRepo] Failed to insert: ${error?.message}`);
      return data as Transaction;
    }
    localDb.transactions.set(txn.id, txn);
    return txn;
  }

  async insertBatch(txns: Transaction[]): Promise<void> {
    if (txns.length === 0) return;
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient
        .from('transactions')
        .upsert(txns, { onConflict: 'user_id, source_ref' });
      if (error) throw new UpstreamError(`[TransactionsRepo] Failed to batch insert: ${error.message}`);
      return;
    }
    for (const t of txns) {
      localDb.transactions.set(t.id, t);
    }
  }

  async updateMatch(
    id: string,
    matchType: 'followed' | 'organic' | 'ignored',
    confidence: number,
    venueId?: string,
    suggestionId?: string,
    category?: string
  ): Promise<Transaction | null> {
    const payload = {
      match_type: matchType,
      confidence,
      venue_id: venueId ?? null,
      linked_suggestion_id: suggestionId ?? null,
      category: category ?? null,
      needs_question: confidence < 0.6
    };
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('transactions')
        .update(payload)
        .eq('id', id)
        .select()
        .single();
      return handleSingleResult<Transaction>(data as Transaction, error, 'TransactionsRepo');
    }
    const t = localDb.transactions.get(id);
    if (!t) return null;
    const updated = { ...t, ...payload };
    localDb.transactions.set(id, updated);
    return updated;
  }

  async updateRating(id: string, rating: 'worth_it' | 'okay' | 'too_much', userId?: string): Promise<Transaction | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient
        .from('transactions')
        .update({ user_rating: rating, needs_question: false })
        .eq('id', id);
      if (userId) {
        query = query.eq('user_id', userId);
      }
      const { data, error } = await query.select().single();
      return handleSingleResult<Transaction>(data as Transaction, error, 'TransactionsRepo');
    }
    const t = localDb.transactions.get(id);
    if (!t) return null;
    if (userId && t.user_id !== userId) return null;
    const updated = { ...t, user_rating: rating, needs_question: false };
    localDb.transactions.set(id, updated);
    return updated;
  }

  async setExcluded(id: string, excluded: boolean, userId?: string): Promise<Transaction | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient
        .from('transactions')
        .update({ excluded })
        .eq('id', id);
      if (userId) {
        query = query.eq('user_id', userId);
      }
      const { data, error } = await query.select().single();
      return handleSingleResult<Transaction>(data as Transaction, error, 'TransactionsRepo');
    }
    const t = localDb.transactions.get(id);
    if (!t) return null;
    if (userId && t.user_id !== userId) return null;
    const updated = { ...t, excluded };
    localDb.transactions.set(id, updated);
    return updated;
  }
}

export const transactionsRepo = new TransactionsRepo();
