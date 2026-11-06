import { localDb, supabaseClient, isRemoteSupabaseEnabled, handleSingleResult } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { Group, GroupPayment } from '../schemas/domain.js';

export class GroupsRepo {
  async createGroup(group: Group): Promise<Group> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('groups').insert(group).select().single();
      if (error || !data) throw new UpstreamError(`[GroupsRepo] Failed to create group: ${error?.message}`);
      return data as Group;
    }
    localDb.groups.set(group.id, group);
    return group;
  }

  async getGroupById(id: string, organizerId?: string): Promise<Group | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient.from('groups').select('*').eq('id', id);
      if (organizerId) {
        query = query.eq('organizer_id', organizerId);
      }
      const { data, error } = await query.single();
      return handleSingleResult<Group>(data as Group, error, 'GroupsRepo');
    }
    const g = localDb.groups.get(id);
    if (!g) return null;
    if (organizerId && g.organizer_id !== organizerId) return null;
    return g;
  }

  async getGroupsByOrganizer(organizerId: string): Promise<Group[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('groups')
        .select('*')
        .eq('organizer_id', organizerId)
        .order('created_at', { ascending: false });
      if (error) throw new UpstreamError(`[GroupsRepo] Failed to fetch groups by organizer: ${error.message}`);
      return (data ?? []) as Group[];
    }
    const result: Group[] = [];
    for (const g of localDb.groups.values()) {
      if (g.organizer_id === organizerId) {
        result.push(g);
      }
    }
    return result.sort(
      (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );
  }

  async getAllPendingGroups(): Promise<Group[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('groups').select('*').eq('status', 'pending');
      if (error) throw new UpstreamError(`[GroupsRepo] Failed to fetch pending groups: ${error.message}`);
      return (data ?? []) as Group[];
    }
    const result: Group[] = [];
    for (const g of localDb.groups.values()) {
      if (g.status === 'pending') {
        result.push(g);
      }
    }
    return result;
  }

  async updateGroupStatus(id: string, status: Group['status']): Promise<Group | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('groups')
        .update({ status })
        .eq('id', id)
        .select()
        .single();
      return handleSingleResult<Group>(data as Group, error, 'GroupsRepo');
    }
    const g = localDb.groups.get(id);
    if (!g) return null;
    const updated = { ...g, status };
    localDb.groups.set(id, updated);
    return updated;
  }

  async createPayments(payments: GroupPayment[]): Promise<GroupPayment[]> {
    if (payments.length === 0) return [];
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('group_payments').insert(payments).select();
      if (error) throw new UpstreamError(`[GroupsRepo] Failed to create payments: ${error.message}`);
      return (data ?? []) as GroupPayment[];
    }
    for (const p of payments) {
      localDb.group_payments.set(p.id, p);
    }
    return payments;
  }

  async getPaymentsByGroupId(groupId: string): Promise<GroupPayment[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('group_payments').select('*').eq('group_id', groupId);
      if (error) throw new UpstreamError(`[GroupsRepo] Failed to fetch payments: ${error.message}`);
      return (data ?? []) as GroupPayment[];
    }
    const result: GroupPayment[] = [];
    for (const p of localDb.group_payments.values()) {
      if (p.group_id === groupId) {
        result.push(p);
      }
    }
    return result;
  }

  async getPaymentByToken(publicToken: string): Promise<GroupPayment | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .select('*')
        .eq('public_token', publicToken)
        .single();
      return handleSingleResult<GroupPayment>(data as GroupPayment, error, 'GroupsRepo');
    }
    for (const p of localDb.group_payments.values()) {
      if (p.public_token === publicToken) {
        return p;
      }
    }
    return null;
  }

  async getPaymentByPayPalRef(paypalRef: string): Promise<GroupPayment | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .select('*')
        .eq('paypal_ref', paypalRef)
        .single();
      return handleSingleResult<GroupPayment>(data as GroupPayment, error, 'GroupsRepo');
    }
    for (const p of localDb.group_payments.values()) {
      if (p.paypal_ref === paypalRef) {
        return p;
      }
    }
    return null;
  }

  async getPaymentById(id: string): Promise<GroupPayment | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .select('*')
        .eq('id', id)
        .single();
      return handleSingleResult<GroupPayment>(data as GroupPayment, error, 'GroupsRepo');
    }
    return localDb.group_payments.get(id) ?? null;
  }

  async updatePaymentStatus(
    id: string,
    status: GroupPayment['status'],
    captureId?: string,
    paidAt?: string,
    paypalRef?: string,
    payUrl?: string,
    refundRef?: string
  ): Promise<GroupPayment | null> {
    const payload: Record<string, unknown> = { status };
    if (captureId) payload.capture_id = captureId;
    if (paidAt) payload.paid_at = paidAt;
    if (paypalRef) payload.paypal_ref = paypalRef;
    if (payUrl) payload.pay_url = payUrl;
    if (refundRef) payload.refund_ref = refundRef;

    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .update(payload)
        .eq('id', id)
        .select()
        .single();
      return handleSingleResult<GroupPayment>(data as GroupPayment, error, 'GroupsRepo');
    }
    const p = localDb.group_payments.get(id);
    if (!p) return null;
    const updated: GroupPayment = {
      ...p,
      status,
      capture_id: captureId ?? p.capture_id,
      paid_at: paidAt ?? p.paid_at,
      paypal_ref: paypalRef ?? p.paypal_ref,
      pay_url: payUrl ?? p.pay_url,
      refund_ref: refundRef ?? p.refund_ref
    };
    localDb.group_payments.set(id, updated);
    return updated;
  }

  /** CAS: sent|viewed|capturing -> paid. Returns null only when no row matched (a lost race); real DB errors throw. */
  async transitionPaymentToPaid(
    id: string,
    captureId: string,
    paidAt: string
  ): Promise<GroupPayment | null> {
    const from: GroupPayment['status'][] = ['sent', 'viewed', 'capturing'];
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .update({ status: 'paid', capture_id: captureId, paid_at: paidAt })
        .eq('id', id)
        .in('status', from)
        .select()
        .maybeSingle();
      if (error) throw new UpstreamError(`[GroupsRepo] transitionPaymentToPaid failed: ${error.message}`);
      return (data as GroupPayment) ?? null;
    }

    const p = localDb.group_payments.get(id);
    if (!p || !from.includes(p.status)) return null;
    const updated: GroupPayment = { ...p, status: 'paid', capture_id: captureId, paid_at: paidAt };
    localDb.group_payments.set(id, updated);
    return updated;
  }

  /** CAS claim before calling PayPal: sent|viewed -> capturing. Only one caller can win. */
  async beginCapture(id: string): Promise<GroupPayment | null> {
    const now = new Date().toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .update({ status: 'capturing', capture_started_at: now })
        .eq('id', id)
        .in('status', ['sent', 'viewed'])
        .select()
        .maybeSingle();
      if (error) throw new UpstreamError(`[GroupsRepo] beginCapture failed: ${error.message}`);
      return (data as GroupPayment) ?? null;
    }
    const p = localDb.group_payments.get(id);
    if (!p || (p.status !== 'sent' && p.status !== 'viewed')) return null;
    const updated: GroupPayment = { ...p, status: 'capturing', capture_started_at: now };
    localDb.group_payments.set(id, updated);
    return updated;
  }

  /** CAS: capturing -> sent (capture did not happen). */
  async releaseCapture(id: string): Promise<void> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient
        .from('group_payments')
        .update({ status: 'sent', capture_started_at: null })
        .eq('id', id)
        .eq('status', 'capturing');
      if (error) throw new UpstreamError(`[GroupsRepo] releaseCapture failed: ${error.message}`);
      return;
    }
    const p = localDb.group_payments.get(id);
    if (p && p.status === 'capturing') localDb.group_payments.set(id, { ...p, status: 'sent', capture_started_at: null });
  }

  /** Releases `capturing` claims older than maxAgeMs (process died mid-capture). Returns released ids. */
  async releaseStaleCaptures(maxAgeMs: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .update({ status: 'sent', capture_started_at: null })
        .eq('status', 'capturing')
        .lt('capture_started_at', cutoff)
        .select('id');
      if (error) throw new UpstreamError(`[GroupsRepo] releaseStaleCaptures failed: ${error.message}`);
      return (data ?? []).map((r: { id: string }) => r.id);
    }
    const released: string[] = [];
    for (const p of localDb.group_payments.values()) {
      if (p.status === 'capturing' && p.capture_started_at && p.capture_started_at < cutoff) {
        localDb.group_payments.set(p.id, { ...p, status: 'sent', capture_started_at: null });
        released.push(p.id);
      }
    }
    return released;
  }

  /** Payments that hold a PayPal capture but are neither paid nor refunded (a late-capture refund failed). */
  async listUnrefundedCaptures(limit = 200): Promise<GroupPayment[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .select('*')
        .not('capture_id', 'is', null)
        .in('status', ['cancelled', 'failed'])
        .is('refund_ref', null)
        .limit(limit);
      if (error) throw new UpstreamError(`[GroupsRepo] listUnrefundedCaptures failed: ${error.message}`);
      return (data ?? []) as GroupPayment[];
    }
    return [...localDb.group_payments.values()]
      .filter((p) => !!p.capture_id && (p.status === 'cancelled' || p.status === 'failed') && !p.refund_ref)
      .slice(0, limit);
  }

  /** CAS: cancel every payment that has not captured money (draft|sent|viewed). Never touches paid/capturing. */
  async cancelUnpaidPayments(groupId: string): Promise<number> {
    const from = ['draft', 'sent', 'viewed'];
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('group_payments')
        .update({ status: 'cancelled' })
        .eq('group_id', groupId)
        .in('status', from)
        .select('id');
      if (error) throw new UpstreamError(`[GroupsRepo] cancelUnpaidPayments failed: ${error.message}`);
      return data?.length ?? 0;
    }
    let n = 0;
    for (const p of localDb.group_payments.values()) {
      if (p.group_id === groupId && from.includes(p.status)) {
        localDb.group_payments.set(p.id, { ...p, status: 'cancelled' });
        n++;
      }
    }
    return n;
  }

  /** First view stamps viewed_at; a `sent` payment also becomes `viewed` (never from any other status). */
  async markPaymentViewed(id: string): Promise<void> {
    const now = new Date().toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const stamp = await supabaseClient.from('group_payments').update({ viewed_at: now }).eq('id', id).is('viewed_at', null);
      if (stamp.error) throw new UpstreamError(`[GroupsRepo] Failed to stamp viewed_at: ${stamp.error.message}`);
      const flip = await supabaseClient.from('group_payments').update({ status: 'viewed' }).eq('id', id).eq('status', 'sent');
      if (flip.error) throw new UpstreamError(`[GroupsRepo] Failed to mark payment viewed: ${flip.error.message}`);
      return;
    }

    const p = localDb.group_payments.get(id);
    if (!p) return;
    localDb.group_payments.set(id, {
      ...p,
      viewed_at: p.viewed_at ?? now,
      status: p.status === 'sent' ? 'viewed' : p.status
    });
  }
}

export const groupsRepo = new GroupsRepo();
