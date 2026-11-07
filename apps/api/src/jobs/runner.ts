import cron from 'node-cron';
import { orchestratorAgent } from '../agents/orchestrator.js';
import { learnerAgent } from '../agents/learner.js';
import { trackerAgent } from '../agents/tracker.js';
import { groupsRepo } from '../repos/groups.js';
import { profilesRepo } from '../repos/profiles.js';
import { vaultRepo } from '../repos/vault.js';
import { approvalsRepo } from '../repos/approvals.js';
import { splitterAgent } from '../agents/splitter.js';
import { localDb, supabaseClient, isRemoteSupabaseEnabled } from '../core/database.js';
import { refundLateCapture } from '../services/settlement.js';
import { erasedUsersRepo } from '../repos/erasedUsers.js';
import { logger } from '../core/logger.js';
import { NotFoundError, ValidationError, UpstreamError } from '../core/errors.js';
import crypto from 'crypto';

/** Calendar date (year, month, day) at instant `d` on the wall clock of `timeZone`. An unknown zone falls back to UTC. */
function localYmd(d: Date, timeZone: string): { y: number; m: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '', 10);
    const y = get('year');
    const m = get('month');
    const day = get('day');
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(day)) return { y, m, day };
  } catch {
    /* unknown time zone: fall through to UTC */
  }
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 'YYYY-MM-DD' of the user's LOCAL calendar day (not the UTC day). */
export function getLocalDateKey(d = new Date(), timeZone = 'UTC'): string {
  const { y, m, day } = localYmd(d, timeZone);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * ISO-8601 week key ('2026-W45') of the user's LOCAL calendar date. Weeks start on the user's Monday, so the key
 * changes at local Monday 00:00. Using the UTC date instead puts a Pacific/Auckland Monday morning (still Sunday in
 * UTC) in the previous week and a Los Angeles Sunday evening in the next one. Defaults to UTC for callers with no zone.
 */
export function getIsoWeekKey(d = new Date(), timeZone = 'UTC'): string {
  const { y, m, day } = localYmd(d, timeZone);
  const date = new Date(Date.UTC(y, m - 1, day));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export const PROFILE_PAGE_SIZE = 200;

export class JobRunner {
  private tasks: Array<{ stop: () => void }> = [];
  private isShuttingDown = false;

  /**
   * Acquire a job lease atomically.
   *
   * Postgres: expired `running` leases for the key are reclaimed with one UPDATE, then ONE INSERT decides the
   * winner through two partial unique indexes (uq_job_runs_active on lease_key where running; uq_job_runs_period
   * on (job, period_key) where running/ok). SQLSTATE 23505 means "not acquired" (returns null). Any other
   * error is a real failure: it is logged and thrown, never turned into a silent skip.
   * Local driver mirrors the same semantics (single synchronous critical section; no awaits between check and set).
   *
   * lease_key = jobName, or `${jobName}:${periodKey}` when a period is given.
   */
  async acquireLease(jobName: string, ttlMinutes = 10, periodKey?: string): Promise<string | null> {
    const runId = crypto.randomUUID();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + ttlMinutes * 60000).toISOString();
    const leaseKey = periodKey ? `${jobName}:${periodKey}` : jobName;

    if (isRemoteSupabaseEnabled && supabaseClient) {
      const reclaim = await supabaseClient
        .from('job_runs')
        .update({ status: 'failed', finished_at: nowIso, detail: { reason: 'lease_expired' } })
        .eq('lease_key', leaseKey)
        .eq('status', 'running')
        .lt('lease_expires_at', nowIso);
      if (reclaim.error) {
        logger.error('[JobRunner] Failed to reclaim stale lease', { leaseKey, code: reclaim.error.code, error: reclaim.error.message });
        throw new UpstreamError(`[JobRunner] Lease reclaim failed (${reclaim.error.code ?? 'UNKNOWN'})`, reclaim.error);
      }

      const { error } = await supabaseClient.from('job_runs').insert({
        id: runId,
        job: jobName,
        lease_key: leaseKey,
        lease_expires_at: expiresIso,
        period_key: periodKey ?? null,
        started_at: nowIso,
        status: 'running'
      });
      if (error) {
        if (error.code === '23505') return null; // lock held / period already ran
        logger.error('[JobRunner] Lease acquisition failed', { leaseKey, code: error.code, error: error.message });
        throw new UpstreamError(`[JobRunner] Lease acquisition failed (${error.code ?? 'UNKNOWN'})`, error);
      }
      return runId;
    }

    // Local driver: mirror the same single-insert semantics synchronously.
    for (const r of localDb.job_runs.values()) {
      if (r.lease_key === leaseKey && r.status === 'running' && r.lease_expires_at && r.lease_expires_at < nowIso) {
        r.status = 'failed';
        r.finished_at = nowIso;
        r.detail = { reason: 'lease_expired' };
      }
    }
    for (const r of localDb.job_runs.values()) {
      if (r.lease_key === leaseKey && r.status === 'running') return null;
      if (periodKey && r.job === jobName && r.period_key === periodKey && (r.status === 'running' || r.status === 'ok')) return null;
    }
    localDb.job_runs.set(runId, {
      id: runId,
      job: jobName,
      lease_key: leaseKey,
      lease_expires_at: expiresIso,
      period_key: periodKey,
      started_at: nowIso,
      status: 'running'
    });
    return runId;
  }

  /**
   * Runs `fn` under a lease and ALWAYS records the outcome: 'ok' if it returns, 'failed' if it throws (the error is
   * rethrown to the caller). Without this a throwing job would leave its lease 'running' until the TTL expired, hiding
   * the failure and blocking a retry. Returns false when another worker already holds the lease.
   */
  async runLeased(leaseKey: string, ttlMinutes: number, periodKey: string | undefined, fn: () => Promise<void>): Promise<boolean> {
    const lease = await this.acquireLease(leaseKey, ttlMinutes, periodKey);
    if (!lease) return false;
    let status: 'ok' | 'failed' = 'failed';
    let detail: Record<string, unknown> | undefined;
    try {
      await fn();
      status = 'ok';
    } catch (err) {
      detail = { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown error' };
      throw err;
    } finally {
      try {
        await this.releaseLease(lease, status, detail);
      } catch (releaseErr) {
        // Never let a bookkeeping failure mask the job's own outcome.
        logger.error('[JobRunner] could not record lease outcome', releaseErr, { leaseKey, status });
      }
    }
    return true;
  }

  /**
   * Release job lease and record outcome
   */
  async releaseLease(leaseId: string, status: 'ok' | 'failed' = 'ok', detail?: Record<string, unknown>): Promise<void> {
    const finishedAt = new Date().toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient
        .from('job_runs')
        .update({ status, finished_at: finishedAt, detail: detail ?? null })
        .eq('id', leaseId);
      if (error) {
        logger.error('[JobRunner] Failed to release lease', { leaseId, error: error.message });
        throw new UpstreamError(`[JobRunner] Failed to release lease: ${error.message}`, error);
      }
      return;
    }

    const run = localDb.job_runs.get(leaseId);
    if (run) {
      run.status = status;
      run.finished_at = finishedAt;
      run.detail = detail;
    }
  }

  /**
   * Initialize all cron schedules
   */
  initJobs(): void {
    // 0. Stuck-work reconciler (approvals, capture claims, failed late refunds)
    const reconcileTask = cron.schedule('*/5 * * * *', async () => {
      await this.reconcileStuckWork();
    });
    this.tasks.push(reconcileTask);

    // 1. Payment Deadline Checks (Every 5 minutes across all users)
    const deadlineTask = cron.schedule('*/5 * * * *', async () => {
      if (this.isShuttingDown) return;
      await this.checkAllDeadlines();
    });
    this.tasks.push(deadlineTask);

    // 2. Hourly User Schedule Sweep (runs every hour at minute 0)
    // Evaluates Friday 17:00, Sunday 19:00, Monday 00:00, Daily Decay & Habits in user's timezone
    const sweepTask = cron.schedule('0 * * * *', async () => {
      if (this.isShuttingDown) return;
      await this.runHourlyUserSweep();
    });
    this.tasks.push(sweepTask);

    logger.info('[JobRunner] Scheduled background tasks initialized with multi-user timezone awareness.');
  }

  /**
   * Graceful shutdown: stop all cron tasks
   */
  shutdown(): void {
    this.isShuttingDown = true;
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    logger.info('[JobRunner] Gracefully stopped all scheduled tasks.');
  }

  /**
   * Finishes or fails work that a crash left half-done, so nothing sits in limbo forever:
   *  - pending past expiry -> expired; approved but never started (15m) -> expired
   *  - executing WITH a recorded outcome (side effect happened) -> executed (never re-run)
   *  - executing without an outcome for 10m -> failed (user may retry with step-up)
   *  - stale `capturing` payment claims -> released
   *  - captures whose automatic refund failed -> refund retried
   */
  async reconcileStuckWork(now = new Date()): Promise<{ approvals: number; captures: number; refunds: number }> {
    const lease = await this.acquireLease('reconcile_stuck_work', 4);
    if (!lease) return { approvals: 0, captures: 0, refunds: 0 };
    const stats = { approvals: 0, captures: 0, refunds: 0 };
    try {
      const open = await approvalsRepo.listOpenForReconcile();
      for (const a of open) {
        try {
          const decidedAgo = a.decided_at ? now.getTime() - new Date(a.decided_at).getTime() : 0;
          if (a.status === 'pending' && new Date(a.expires_at) < now) {
            await approvalsRepo.updateStatus(a.id, 'expired', undefined, a.user_id, undefined, ['pending']);
            stats.approvals++;
          } else if (a.status === 'approved' && decidedAgo > 15 * 60_000) {
            await approvalsRepo.updateStatus(a.id, 'expired', { error: 'STUCK_APPROVED' }, a.user_id, undefined, ['approved']);
            stats.approvals++;
          } else if (a.status === 'executing' && a.execution_outcome && decidedAgo > 2 * 60_000) {
            await approvalsRepo.updateStatus(a.id, 'executed', a.execution_outcome as Record<string, unknown>, a.user_id, undefined, ['executing']);
            stats.approvals++;
          } else if (a.status === 'executing' && !a.execution_outcome && decidedAgo > 10 * 60_000) {
            await approvalsRepo.updateStatus(a.id, 'failed', { error: 'STUCK_EXECUTING' }, a.user_id, undefined, ['executing']);
            stats.approvals++;
          }
        } catch (err) {
          logger.error('[JobRunner] reconcile approval failed', { approvalId: a.id, error: String(err) });
        }
      }

      stats.captures = (await groupsRepo.releaseStaleCaptures(10 * 60_000)).length;

      for (const p of await groupsRepo.listUnrefundedCaptures()) {
        if (!p.capture_id) continue;
        const r = await refundLateCapture(p.id, p.capture_id, 'reconciler');
        if (r.outcome === 'late_capture_refunded') stats.refunds++;
      }

      // Retry pending auth deletions
      try {
        const pendingDeletes = await erasedUsersRepo.listPendingAuthDeletes(50);
        for (const uid of pendingDeletes) {
          if (isRemoteSupabaseEnabled && supabaseClient) {
            const { error } = await supabaseClient.auth.admin.deleteUser(uid);
            if (!error) await erasedUsersRepo.markAuthDeleted(uid);
          } else {
            await erasedUsersRepo.markAuthDeleted(uid);
          }
        }
      } catch (err) {
        logger.warn('[JobRunner] Pending auth delete retry failed', { error: String(err) });
      }

      await this.releaseLease(lease, 'ok', stats);
    } catch (err) {
      await this.releaseLease(lease, 'failed', { error: 'RECONCILE_FAILED' });
      logger.error('[JobRunner] reconcileStuckWork failed', { error: String(err) });
    }
    return stats;
  }

  /**
   * Check deadlines for all pending outing groups across the system (or filtered by user)
   */
  async checkAllDeadlines(targetUserId?: string): Promise<number> {
    const leaseKey = targetUserId ? `deadline_checks_${targetUserId}` : 'deadline_checks_all';
    const lease = await this.acquireLease(leaseKey, 4);
    if (!lease) {
      logger.info('[JobRunner] Deadline check skipped: lock held by another worker.');
      return 0;
    }

    let updatedCount = 0;
    try {
      let pendingGroups = await groupsRepo.getAllPendingGroups();
      if (targetUserId) {
        pendingGroups = pendingGroups.filter((g) => g.organizer_id === targetUserId);
      }
      const now = new Date();

      for (const group of pendingGroups) {
        if (new Date(group.deadline) < now) {
          try {
            // 1. Close the door first (CAS): nobody can start paying an expired outing.
            await groupsRepo.cancelUnpaidPayments(group.id);
            const payments = await groupsRepo.getPaymentsByGroupId(group.id);
            if (payments.some((p) => p.status === 'capturing')) {
              continue; // a capture is in flight; settle it first, handle next cycle
            }
            if (payments.some((p) => p.status === 'paid')) {
              // 2. Refunding friends' own money must not depend on the organizer clicking approve.
              await approvalsRepo.voidPendingForGroup(group.id);
              await splitterAgent.refundAllPaid(group.id, { finalStatus: 'refunded', actor: 'system' });
              logger.info('[JobRunner] Auto-refunded expired group', { groupId: group.id });
            } else {
              await groupsRepo.updateGroupStatus(group.id, 'cancelled');
              await approvalsRepo.voidPendingForGroup(group.id);
              logger.info('[JobRunner] Cancelled unpaid expired group', { groupId: group.id });
            }
            updatedCount++;
          } catch (err) {
            logger.error('[JobRunner] Error processing expired group', { groupId: group.id, error: String(err) });
          }
        }
      }

      await this.releaseLease(lease, 'ok', { updatedCount });
    } catch (err) {
      await this.releaseLease(lease, 'failed', { error: String(err) });
      logger.error('[JobRunner] checkAllDeadlines failed', err);
    }
    return updatedCount;
  }

  async checkDeadlines(userId?: string): Promise<number> {
    return this.checkAllDeadlines(userId);
  }

  /**
   * Hourly sweep across all user profiles in their local timezone
   */
  async runHourlyUserSweep(): Promise<void> {
    const lease = await this.acquireLease('hourly_user_sweep', 50);
    if (!lease) return;

    try {
      let processedUsers = 0;
      // Page through ALL profiles (200 at a time). A single unpaged select is capped by PostgREST (1000 rows by
      // default), which would silently skip every user beyond the cap.
      await profilesRepo.forEachPage(PROFILE_PAGE_SIZE, async (page) => {
        for (const profile of page) {
          processedUsers++;
          try {
            await this.processUserSchedule(profile);
          } catch (userErr) {
            logger.error('[JobRunner] Failed processing user schedule', userErr, { userId: profile.id });
          }
        }
      });
      await this.releaseLease(lease, 'ok', { processedUsers });
    } catch (err) {
      await this.releaseLease(lease, 'failed', { error: String(err) });
      logger.error('[JobRunner] runHourlyUserSweep failed', err);
    }
  }

  /**
   * Process timezone-specific scheduled events for an individual user
   */
  async processUserSchedule(profile: { id: string; timezone: string; guilt_free_cap_minor: number }): Promise<void> {
    const tz = profile.timezone || 'UTC';
    const now = new Date();

    // Determine day of week (0=Sun..6=Sat) and hour (0..23) in user's timezone
    let localDay: number;
    let localHour: number;
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: 'numeric',
        hourCycle: 'h23' // deterministic 0-23; hour12:false can render midnight as 24 on some ICU builds
      });
      const parts = formatter.formatToParts(now);
      const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
      localHour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
      const daysMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      localDay = daysMap[weekdayStr] ?? 0;
    } catch {
      localDay = now.getUTCDay();
      localHour = now.getUTCHours();
    }

    const weekKey = getIsoWeekKey(now, tz); // the user's LOCAL week
    const dayKey = getLocalDateKey(now, tz); // the user's LOCAL day

    // A. Friday 17:00 Briefing
    if (localDay === 5 && localHour === 17) {
      await this.runLeased(`friday_brief_${profile.id}_${weekKey}`, 120, weekKey, async () => {
        await orchestratorAgent.postProactiveNote(profile.id, 'friday_brief');
        logger.info('[JobRunner] Delivered Friday Briefing', { userId: profile.id, tz });
      });
    }

    // B. Sunday 19:00 Vault Prompt
    if (localDay === 0 && localHour === 19) {
      await this.runLeased(`sunday_vault_${profile.id}_${weekKey}`, 120, weekKey, async () => {
        await orchestratorAgent.postProactiveNote(profile.id, 'sunday_vault');
        logger.info('[JobRunner] Delivered Sunday Vault Prompt', { userId: profile.id, tz });
      });
    }

    // C. Monday 00:00 Weekly Pocket Reset to guilt_free_cap
    if (localDay === 1 && localHour === 0) {
      await this.runLeased(`monday_reset_${profile.id}_${weekKey}`, 120, weekKey, async () => {
        const existingPocket = await vaultRepo.getPocket(profile.id, 'weekly');
        if (!existingPocket || existingPocket.balance_minor <= 0) {
          await vaultRepo.updatePocket({
            user_id: profile.id,
            kind: 'weekly',
            balance_minor: profile.guilt_free_cap_minor,
            is_simulated: true
          });
          logger.info('[JobRunner] Reset weekly pocket balance to cap', {
            userId: profile.id,
            capMinor: profile.guilt_free_cap_minor
          });
        }
      });
    }

    // D. Daily 00:00 Preference Decay
    if (localHour === 0) {
      // periodKey makes the day a unique (job, period) pair: a finished run is not repeated by a later sweep that hour.
      await this.runLeased(`decay_${profile.id}_${dayKey}`, 120, dayKey, async () => {
        await learnerAgent.decay(profile.id);
      });
    }

    // E. Daily 02:00 Habit Mining
    if (localHour === 2) {
      await this.runLeased(`habits_${profile.id}_${dayKey}`, 120, dayKey, async () => {
        await trackerAgent.mineHabits(profile.id);
      });
    }
  }

  /**
   * Programmatic trigger for testing or manual execution
   */
  async triggerJob(name: string, targetUserId?: string): Promise<string> {
    const userId = targetUserId ?? (await profilesRepo.getAll())[0]?.id;
    if (!userId) throw new NotFoundError('No user profile found to execute job.');

    if (name === 'fridayBrief') {
      await orchestratorAgent.postProactiveNote(userId, 'friday_brief');
      return 'Friday briefing posted to chat drawer.';
    } else if (name === 'weekendVault') {
      await orchestratorAgent.postProactiveNote(userId, 'sunday_vault');
      return 'Sunday vault prompt posted to chat drawer.';
    } else if (name === 'decay') {
      await learnerAgent.decay(userId);
      return 'Preference decay completed.';
    } else if (name === 'habitMiner') {
      const habits = await trackerAgent.mineHabits(userId);
      return `Habit mining complete: ${habits.length} habits identified.`;
    } else if (name === 'deadlineCheck') {
      const count = await this.checkAllDeadlines();
      return `Deadline check complete: ${count} expired groups handled.`;
    } else if (name === 'weeklyReset') {
      const profile = await profilesRepo.getById(userId);
      if (profile) {
        await vaultRepo.updatePocket({
          user_id: userId,
          kind: 'weekly',
          balance_minor: profile.guilt_free_cap_minor,
          is_simulated: true
        });
      }
      return 'Weekly pocket reset completed.';
    }
    throw new ValidationError(`Unknown job name: ${name}`);
  }
}

export const jobRunner = new JobRunner();
