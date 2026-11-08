import { Router } from 'express';
import { transactionsRepo } from '../repos/transactions.js';
import { subscriptionsRepo } from '../repos/subscriptions.js';
import { approvalsRepo, getLocalMondayStart } from '../repos/approvals.js';
import { profilesRepo } from '../repos/profiles.js';
import { moneyService } from '../services/money.js';
import { sendSuccess, handleRouteError, ValidationError } from '../core/errors.js';
import { getAuthReq } from '../core/auth.js';

export const receiptRouter = Router();

const ymdFmt = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });

/** An instant that falls on local calendar day y-m-d in `tz` (so Monday lookup is correct in any zone). */
function instantOnLocalDate(y: number, m: number, d: number, tz: string): Date {
  const target = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let t = Date.UTC(y, m - 1, d, 12);
  for (let i = 0; i < 3; i++) {
    const got = ymdFmt(tz).format(new Date(t));
    if (got === target) break;
    t += got < target ? 86_400_000 : -86_400_000;
  }
  return new Date(t);
}

function isoWeekMonday(year: number, week: number): [number, number, number] {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7));
  const monday = new Date(week1Monday + (week - 1) * 7 * 86_400_000);
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  if (week < 1 || thursday.getUTCFullYear() !== year) {
    throw new ValidationError(`Invalid ISO week "${year}-W${String(week).padStart(2, '0')}".`);
  }
  return [monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()];
}

/**
 * Accepts `current`, `YYYY-MM-DD` (any day; resolves to that day's Monday) or ISO `YYYY-Www`.
 * Anything else is a 400: we never silently answer for a different week than the one requested.
 * Boundaries are the user's local Monday 00:00 so they match the weekly-cap window.
 */
function getWeekRange(weekParam: string, timeZone: string): { start: Date; end: Date; label: string } {
  let anchor: Date;
  if (weekParam === 'current') {
    anchor = new Date();
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
    const [y, m, d] = weekParam.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
      throw new ValidationError(`Invalid date "${weekParam}".`);
    }
    anchor = instantOnLocalDate(y, m, d, timeZone);
  } else if (/^\d{4}-W\d{2}$/.test(weekParam)) {
    const [yStr, wStr] = weekParam.split('-W') as [string, string];
    const [y, m, d] = isoWeekMonday(parseInt(yStr, 10), parseInt(wStr, 10));
    anchor = instantOnLocalDate(y, m, d, timeZone);
  } else {
    throw new ValidationError('Week must be "current", YYYY-MM-DD, or an ISO week like 2026-W44.');
  }
  const start = getLocalMondayStart(anchor, timeZone);
  const end = getLocalMondayStart(new Date(start.getTime() + 7 * 86_400_000 + 12 * 3_600_000), timeZone);
  return { start, end, label: ymdFmt(timeZone).format(new Date(start.getTime() + 12 * 3_600_000)) };
}

receiptRouter.get('/api/receipt/:week', async (req, res) => {
  const authReq = getAuthReq(req);
  try {
    const week = req.params['week'] as string;
    const user = await profilesRepo.getById(authReq.userId);
    const currency = user?.currency ?? 'USD';

    const { start: weekStart, end: weekEnd, label: weekLabel } = getWeekRange(week, user?.timezone || 'UTC');

    const txns = await transactionsRepo.getByUserId(authReq.userId);
    const leisureTxns = txns.filter((t) => {
      if (t.kind !== 'leisure' || t.excluded) return false;
      const occTime = new Date(t.occurred_at).getTime();
      return occTime >= weekStart.getTime() && occTime < weekEnd.getTime();
    });

    const totalSpentMinor = leisureTxns.reduce((a, b) => a + b.amount_minor, 0);

    // Cancelled subscriptions savings - only count those cancelled within the requested week
    const approvals = await approvalsRepo.getByUserId(authReq.userId);
    const cancelledInWeekSubIds = new Set<string>();
    for (const a of approvals) {
      if (a.action_type === 'cancel_subscription' && a.status === 'executed') {
        const decidedTime = new Date(a.decided_at ?? 0).getTime();
        if (decidedTime >= weekStart.getTime() && decidedTime < weekEnd.getTime()) {
          const subIds = (a.payload?.['subscriptionIds'] as string[]) || [];
          for (const sid of subIds) cancelledInWeekSubIds.add(sid);
        }
      }
    }

    const subs = await subscriptionsRepo.getByUserId(authReq.userId);
    const cancelledSubs = subs.filter((s) => {
      if (s.status !== 'cancelled') return false;
      if (cancelledInWeekSubIds.has(s.id)) return true;
      const cTime = s.cancelled_at ? new Date(s.cancelled_at).getTime() : null;
      if (cTime && cTime >= weekStart.getTime() && cTime < weekEnd.getTime()) return true;
      return false;
    });
    const recoveredMinor = cancelledSubs.reduce((a, b) => a + b.amount_minor, 0);

    const distinctCategories = new Set(
      leisureTxns.map((t) => t.category).filter((c): c is string => Boolean(c))
    );
    const categoryCount = distinctCategories.size;
    const comfortZoneGrowth =
      categoryCount > 0
        ? `Explored ${categoryCount} distinct ${categoryCount === 1 ? 'category' : 'categories'} this period`
        : 'Zero leisure outings logged for this period';

    const receipt = {
      week: weekLabel, // canonical Monday (user's timezone) that the data below actually covers
      requestedWeek: week,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      userName: user?.name ?? 'Pocketful Member',
      items: leisureTxns.map((t) => ({
        name: t.merchant_raw,
        category: t.category ?? 'leisure',
        amountMinor: t.amount_minor,
        amountFormatted: moneyService.format(t.amount_minor, currency),
        label: t.match_type === 'followed' ? 'Followed Pip' : 'You chose this'
      })),
      totalSpentMinor,
      totalSpentFormatted: moneyService.format(totalSpentMinor, currency),
      recoveredFromSubscriptionsMinor: recoveredMinor,
      recoveredFormatted: moneyService.format(recoveredMinor, currency),
      comfortZoneGrowth,
      doubleRuleTotal: moneyService.format(totalSpentMinor, currency),
      issuedAt: new Date().toISOString()
    };

    sendSuccess(res, { receipt }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
