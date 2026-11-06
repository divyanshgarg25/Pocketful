import crypto from 'crypto';
import { localDb, supabaseClient, isRemoteSupabaseEnabled, type LocalSettlement } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';

export type SettlementEntry = LocalSettlement;
export type NewSettlement = Omit<SettlementEntry, 'id' | 'created_at'>;

export interface SettlementSummary {
  groupId: string;
  currency: string | null;
  collectedMinor: number;
  refundedMinor: number;
  /** collected - refunded: what the platform's PayPal account currently holds for this outing. */
  heldMinor: number;
  captures: number;
  refunds: number;
}

/**
 * The append-only record of money actually moved (see migration 008). Rows are never updated or deleted; recording is
 * idempotent per (payment, kind), so a retried webhook or a re-run refund can call record() again safely.
 */
export class SettlementsRepo {
  /** Inserts the entry unless one already exists for (payment, kind). Returns true if a new row was written. */
  async record(entry: NewSettlement): Promise<boolean> {
    if (!Number.isInteger(entry.amount_minor) || entry.amount_minor <= 0) {
      throw new UpstreamError('[Settlements] amount_minor must be a positive integer');
    }
    const row: SettlementEntry = { ...entry, id: crypto.randomUUID(), created_at: new Date().toISOString() };
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('settlements')
        .upsert(row, { onConflict: 'payment_id,kind', ignoreDuplicates: true })
        .select('id');
      if (error) throw new UpstreamError(`[Settlements] write failed: ${error.message}`);
      return (data ?? []).length === 1;
    }
    const key = `${row.payment_id}:${row.kind}`;
    if (localDb.settlements.has(key)) return false;
    localDb.settlements.set(key, row);
    return true;
  }

  async listForGroup(groupId: string): Promise<SettlementEntry[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('settlements')
        .select('*')
        .eq('group_id', groupId)
        .order('created_at', { ascending: true });
      if (error) throw new UpstreamError(`[Settlements] read failed: ${error.message}`);
      return (data ?? []) as SettlementEntry[];
    }
    return [...localDb.settlements.values()]
      .filter((s) => s.group_id === groupId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((s) => ({ ...s }));
  }

  async summarize(groupId: string): Promise<SettlementSummary> {
    const rows = await this.listForGroup(groupId);
    const sum = (kind: 'capture' | 'refund') => rows.filter((r) => r.kind === kind).reduce((a, r) => a + Number(r.amount_minor), 0);
    const collectedMinor = sum('capture');
    const refundedMinor = sum('refund');
    return {
      groupId,
      currency: rows[0]?.currency ?? null,
      collectedMinor,
      refundedMinor,
      heldMinor: collectedMinor - refundedMinor,
      captures: rows.filter((r) => r.kind === 'capture').length,
      refunds: rows.filter((r) => r.kind === 'refund').length
    };
  }
}

export const settlementsRepo = new SettlementsRepo();
