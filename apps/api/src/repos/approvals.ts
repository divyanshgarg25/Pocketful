import { localDb, supabaseClient, isRemoteSupabaseEnabled } from '../core/database.js';
import {
  UpstreamError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ApprovalExpiredError,
  GuardianBlockedError
} from '../core/errors.js';
import type { Approval } from '../schemas/domain.js';
import { profilesRepo } from './profiles.js';

function getTimezoneOffsetMs(timeZone: string, date = new Date()): number {
  try {
    const tz = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).format(date);
    const match = tz.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (!match || !match[1] || !match[2]) return 0;
    const sign = match[1] === '+' ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return sign * (hours * 60 + minutes) * 60 * 1000;
  } catch {
    return 0;
  }
}

export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ValidationError(`Invalid timezone: ${timeZone}`);
  }
}

export function getLocalMondayStart(now = new Date(), timeZone = 'America/Los_Angeles'): Date {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localYmd = dtf.format(now);
    const [yStr, mStr, dStr] = localYmd.split('-');
    const y = parseInt(yStr || '0', 10);
    const m = parseInt(mStr || '1', 10);
    const d = parseInt(dStr || '1', 10);
    const localDate = new Date(Date.UTC(y, m - 1, d));
    const dayOfWeek = localDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const diffToMonday = (dayOfWeek + 6) % 7;
    localDate.setUTCDate(localDate.getUTCDate() - diffToMonday);
    const invDate = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), 0, 0, 0));
    const offset = getTimezoneOffsetMs(timeZone, invDate);
    return new Date(invDate.getTime() - offset);
  } catch {
    // Fallback to UTC Monday
    const startOfWeek = new Date(now);
    startOfWeek.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    startOfWeek.setUTCHours(0, 0, 0, 0);
    return startOfWeek;
  }
}

const userLocks = new Map<string, Promise<void>>();
async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => gate);
  userLocks.set(userId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(userId) === chained) userLocks.delete(userId);
  }
}

export class ApprovalsRepo {
  async create(approval: Approval): Promise<Approval> {
    const withCreated: Approval = { ...approval, created_at: approval.created_at ?? new Date().toISOString() };
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('approvals').insert(withCreated).select().single();
      if (error || !data) throw new UpstreamError(`[ApprovalsRepo] Failed to create: ${error?.message}`);
      return data as Approval;
    }
    localDb.approvals.set(withCreated.id, withCreated);
    return withCreated;
  }

  async getById(id: string, userId?: string): Promise<Approval | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient.from('approvals').select('*').eq('id', id);
      if (userId) {
        query = query.eq('user_id', userId);
      }
      const { data, error } = await query.single();
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw new UpstreamError(`[ApprovalsRepo] Failed to get approval: ${error.message}`);
      }
      return (data as Approval) ?? null;
    }
    const a = localDb.approvals.get(id);
    if (!a) return null;
    if (userId && a.user_id !== userId) return null;
    return a;
  }

  async getByUserId(userId: string): Promise<Approval[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('approvals')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw new UpstreamError(`[ApprovalsRepo] Failed to fetch approvals: ${error.message}`);
      return (data ?? []) as Approval[];
    }
    const result: Approval[] = [];
    for (const a of localDb.approvals.values()) {
      if (a.user_id === userId) result.push(a);
    }
    return result.sort((a, b) => new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime());
  }

  /**
   * Idempotency check: Lookups must ignore dead/expired approvals so a fresh one can be staged.
   */
  async getByIdempotencyKey(userIdOrKey: string, maybeKey?: string): Promise<Approval | null> {
    const userId = maybeKey ? userIdOrKey : undefined;
    const key = maybeKey ? maybeKey : userIdOrKey;

    const isLive = (a: Approval): boolean => {
      if (userId && a.user_id !== userId) return false;
      if (a.idempotency_key !== key) return false;
      const isDead =
        a.status === 'denied' ||
        a.status === 'expired' ||
        a.status === 'failed' ||
        a.status === 'cancelled' ||
        new Date(a.expires_at) < new Date();
      return !isDead;
    };

    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient
        .from('approvals')
        .select('*')
        .eq('idempotency_key', key)
        .not('status', 'in', '("denied","expired","failed","cancelled")')
        .gt('expires_at', new Date().toISOString());

      if (userId) {
        query = query.eq('user_id', userId);
      }

      const { data, error } = await query.maybeSingle();
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw new UpstreamError(`[ApprovalsRepo] Failed to get approval by idempotency key: ${error.message}`);
      }
      return (data as Approval) ?? null;
    }

    for (const a of localDb.approvals.values()) {
      if (isLive(a)) {
        return a;
      }
    }
    return null;
  }

  async setChallengeNonce(id: string, userId: string, nonce: string | null, expiresAt: string | null, fingerprint: string | null = null): Promise<boolean> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient
        .from('approvals')
        .update({ challenge_nonce: nonce, challenge_expires_at: expiresAt, challenge_fingerprint: fingerprint })
        .eq('id', id)
        .eq('user_id', userId);
      return !error;
    }
    const a = localDb.approvals.get(id);
    if (!a || a.user_id !== userId) return false;
    a.challenge_nonce = nonce ?? undefined;
    a.challenge_expires_at = expiresAt ?? undefined;
    a.challenge_fingerprint = fingerprint ?? undefined;
    return true;
  }

  /**
   * Atomic single-use consume: clears the challenge ONLY IF the stored nonce still equals `nonce`.
   * Returns true for exactly one caller even under concurrency.
   */
  async consumeChallengeNonce(id: string, userId: string, nonce: string): Promise<boolean> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('approvals')
        .update({ challenge_nonce: null, challenge_expires_at: null, challenge_fingerprint: null })
        .eq('id', id)
        .eq('user_id', userId)
        .eq('challenge_nonce', nonce)
        .select('id');
      if (error) throw new UpstreamError(`[Approvals] challenge consume failed: ${error.message}`);
      return (data ?? []).length === 1;
    }
    const a = localDb.approvals.get(id);
    if (!a || a.user_id !== userId || a.challenge_nonce !== nonce) return false;
    a.challenge_nonce = undefined;
    a.challenge_expires_at = undefined;
    a.challenge_fingerprint = undefined;
    return true;
  }

  async clearChallengeNonce(id: string, userId?: string): Promise<boolean> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient
        .from('approvals')
        .update({ challenge_nonce: null, challenge_expires_at: null, challenge_fingerprint: null })
        .eq('id', id);
      if (userId) query = query.eq('user_id', userId);
      const { error } = await query;
      return !error;
    }
    const a = localDb.approvals.get(id);
    if (!a || (userId && a.user_id !== userId)) return false;
    a.challenge_nonce = undefined;
    a.challenge_expires_at = undefined;
    a.challenge_fingerprint = undefined;
    return true;
  }

  /**
   * Atomic begin-of-execution: re-checks CURRENT caps (per-action, weekly incl. everything already
   * executing/executed this week, zero-cap lock) and flips status -> 'executing' in one critical
   * section. Postgres: single `begin_execution` RPC under a per-user advisory lock.
   * Local driver: per-user mutex with identical rules.
   * Throws GuardianBlockedError / ConflictError / ApprovalExpiredError / NotFoundError.
   */
  async beginExecution(
    id: string,
    userId: string,
    from: Approval['status'][] = ['approved']
  ): Promise<Approval> {
    const profile = await profilesRepo.getById(userId);
    if (!profile) throw new NotFoundError('User profile not found.');

    const raise = (r: { code?: string; reason?: string; status?: string }): never => {
      switch (r.code) {
        case 'NOT_FOUND':
          throw new NotFoundError('Approval record not found.');
        case 'EXPIRED':
          throw new ApprovalExpiredError('This approval request has expired. Please approve again.');
        case 'BAD_STATUS':
          throw new ConflictError(`Approval cannot be executed from status "${r.status}".`);
        case 'ALREADY_EXECUTED_SIDE_EFFECT':
          throw new ConflictError('This approval already performed its action and is awaiting reconciliation.');
        default:
          throw new GuardianBlockedError(`Action blocked at execution time: ${r.reason ?? 'cap exceeded'}`);
      }
    };

    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.rpc('begin_execution', {
        p_approval: id,
        p_user: userId,
        p_tz: profile.timezone || 'UTC',
        p_from: from
      });
      if (error) throw new UpstreamError(`[ApprovalsRepo] begin_execution failed: ${error.message}`);
      const r = data as { ok: boolean; code?: string; reason?: string; status?: string };
      if (!r?.ok) raise(r ?? {});
      const fresh = await this.getById(id, userId);
      if (!fresh) throw new NotFoundError('Approval record not found.');
      return fresh;
    }

    return withUserLock(userId, async () => {
      const a = localDb.approvals.get(id);
      if (!a || a.user_id !== userId) return raise({ code: 'NOT_FOUND' });
      const cur = a!;
      if (!from.includes(cur.status)) return raise({ code: 'BAD_STATUS', status: cur.status });
      if (cur.status === 'approved' && new Date(cur.expires_at).getTime() <= Date.now()) {
        return raise({ code: 'EXPIRED' });
      }
      if (cur.execution_outcome) return raise({ code: 'ALREADY_EXECUTED_SIDE_EFFECT' });

      const mo = cur.money_out_minor ?? 0;
      if (mo > 0) {
        if (profile.per_action_cap_minor === 0 || profile.weekly_cap_minor === 0) {
          return raise({ code: 'CAP_ZERO', reason: 'Spending safety cap is set to zero (spending is locked).' });
        }
        if (profile.per_action_cap_minor > 0 && mo > profile.per_action_cap_minor) {
          return raise({ code: 'PER_ACTION_CAP', reason: 'Amount exceeds your per-action safety cap.' });
        }
        const weekStart = getLocalMondayStart(new Date(), profile.timezone || 'UTC').getTime();
        let used = 0;
        for (const o of localDb.approvals.values()) {
          if (o.user_id !== userId || o.id === id) continue;
          if (o.status !== 'executing' && o.status !== 'executed') continue;
          const t = new Date(o.executed_at ?? o.decided_at ?? new Date().toISOString()).getTime();
          if (t >= weekStart) used += o.money_out_minor ?? 0;
        }
        if (profile.weekly_cap_minor > 0 && used + mo > profile.weekly_cap_minor) {
          return raise({ code: 'WEEKLY_CAP', reason: 'This action would exceed your weekly safety cap.' });
        }
      }
      const updated: Approval = {
        ...cur,
        status: 'executing',
        retry_count: cur.status === 'failed' ? (cur.retry_count ?? 0) + 1 : (cur.retry_count ?? 0)
      };
      localDb.approvals.set(id, updated);
      return updated;
    });
  }

  /** @deprecated use beginExecution (kept so older callers still get cap enforcement). */
  async transitionToExecuting(id: string, userId: string): Promise<Approval | null> {
    try {
      return await this.beginExecution(id, userId, ['approved']);
    } catch (err) {
      if (err instanceof ConflictError || err instanceof ApprovalExpiredError || err instanceof NotFoundError) {
        return null;
      }
      throw err;
    }
  }

  async updateStatus(
    id: string,
    status: Approval['status'],
    result?: Record<string, unknown>,
    userId?: string,
    extraFields?: Partial<Approval>,
    expectedCurrentStatuses?: Approval['status'][]
  ): Promise<Approval | null> {
    const terminalStatuses: Approval['status'][] = ['executed', 'denied', 'expired', 'cancelled'];

    const decidedAt = status === 'approved' || status === 'denied' ? new Date().toISOString() : undefined;
    const executedAt = status === 'executed' ? new Date().toISOString() : undefined;

    const payload: Record<string, unknown> = { status, ...(extraFields || {}) };
    if (result !== undefined) payload.result = result;
    if (decidedAt) payload.decided_at = decidedAt;
    if (executedAt) payload.executed_at = executedAt;

    if (isRemoteSupabaseEnabled && supabaseClient) {
      let query = supabaseClient.from('approvals').update(payload).eq('id', id);
      if (userId) query = query.eq('user_id', userId);
      query = query.not('status', 'in', '("executed","denied","expired","cancelled")');
      if (expectedCurrentStatuses && expectedCurrentStatuses.length > 0) {
        query = query.in('status', expectedCurrentStatuses);
      }
      const { data, error } = await query.select().maybeSingle();
      if (error) throw new UpstreamError(`[ApprovalsRepo] Failed to update status: ${error.message}`);
      return (data as Approval) ?? null;
    }

    const a = localDb.approvals.get(id);
    if (!a) return null;
    if (userId && a.user_id !== userId) return null;
    if (terminalStatuses.includes(a.status)) return null;
    if (expectedCurrentStatuses && expectedCurrentStatuses.length > 0) {
      if (!expectedCurrentStatuses.includes(a.status)) return null;
    }

    const updated: Approval = {
      ...a,
      status,
      result: result ?? a.result,
      decided_at: decidedAt ?? a.decided_at,
      executed_at: executedAt ?? a.executed_at,
      ...(extraFields || {})
    };
    localDb.approvals.set(id, updated);
    return updated;
  }

  /** All approvals still in a non-final state (pending/approved/executing), across users. Reconciler use only. */
  async listOpenForReconcile(limit = 500): Promise<Approval[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('approvals')
        .select('*')
        .in('status', ['pending', 'approved', 'executing'])
        .limit(limit);
      if (error) throw new UpstreamError(`[ApprovalsRepo] listOpenForReconcile failed: ${error.message}`);
      return (data ?? []) as Approval[];
    }
    return [...localDb.approvals.values()]
      .filter((a) => a.status === 'pending' || a.status === 'approved' || a.status === 'executing')
      .slice(0, limit);
  }

  async voidPendingForGroup(groupId: string): Promise<number> {
    let count = 0;
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('approvals')
        .update({ status: 'cancelled' })
        .eq('action_type', 'send_requests')
        .in('status', ['pending', 'approved'])
        .contains('payload', { groupId })
        .select();
      if (error) throw new UpstreamError(`[ApprovalsRepo] Failed to void pending approvals: ${error.message}`);
      return data?.length ?? 0;
    }

    for (const a of localDb.approvals.values()) {
      if (a.action_type === 'send_requests' && (a.status === 'pending' || a.status === 'approved')) {
        const p = a.payload as { groupId?: string; group_id?: string };
        if (p?.groupId === groupId || p?.group_id === groupId) {
          a.status = 'cancelled';
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Sum of money_out_minor for executed approvals in the user's CURRENT local week (Monday 00:00 in `timeZone`).
   * Fail-closed: an invalid timezone or any DB error throws; it never falls back to UTC or to 0.
   */
  async getExecutedThisWeekTotal(userId: string, timeZone = 'America/Los_Angeles'): Promise<number> {
    assertValidTimeZone(timeZone);
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.rpc('weekly_money_out_for', { p_user: userId, p_tz: timeZone });
      if (error) {
        throw new UpstreamError(`[ApprovalsRepo] Failed to fetch weekly money out: ${error.message}`);
      }
      return Number(data ?? 0);
    }

    // The exact local week [Monday 00:00, next Monday 00:00) in the user's zone, like the SQL function. The next
    // boundary is found from noon a week later so a 23h/25h DST week cannot push it onto the wrong day.
    const startOfWeek = getLocalMondayStart(new Date(), timeZone);
    const endOfWeek = getLocalMondayStart(new Date(startOfWeek.getTime() + 7 * 86_400_000 + 12 * 3_600_000), timeZone);

    let total = 0;
    for (const a of localDb.approvals.values()) {
      if (a.user_id === userId && a.status === 'executed' && a.executed_at) {
        const execTime = new Date(a.executed_at);
        if (execTime >= startOfWeek && execTime < endOfWeek) {
          total += a.money_out_minor ?? 0;
        }
      }
    }
    return total;
  }
}

export const approvalsRepo = new ApprovalsRepo();
