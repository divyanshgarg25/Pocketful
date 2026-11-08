import { Router } from 'express';
import { z } from 'zod';
import { occasionsRepo } from '../repos/occasions.js';
import { profilesRepo } from '../repos/profiles.js';
import { vaultRepo } from '../repos/vault.js';
import { geminiService } from '../services/gemini.js';
import { moneyService } from '../services/money.js';
import { sendSuccess, sendError, handleRouteError } from '../core/errors.js';
import type { AuthenticatedRequest } from '../core/auth.js';

export const occasionsRouter = Router();

/**
 * Maps the user's timezone / currency / home label to a holiday-calendar region. Returns null when none of them
 * identifies one: guessing (the old behaviour defaulted everyone to California) shows people holidays that are not
 * theirs, so callers must surface a "set your region" state instead.
 */
export function deriveRegion(timezone?: string | null, currency?: string | null, homeLabel?: string | null): string | null {
  const tz = (timezone || '').toLowerCase();
  const curr = (currency || '').toUpperCase();
  const label = (homeLabel || '').toLowerCase();

  if (curr === 'INR' || tz.includes('kolkata') || tz.includes('calcutta') || label.includes('india')) {
    return 'IN';
  }
  if (curr === 'GBP' || tz.includes('london')) {
    return 'GB';
  }
  if (curr === 'EUR' || tz.includes('paris') || tz.includes('berlin') || tz.includes('rome') || tz.includes('madrid')) {
    return 'EU';
  }
  if (curr === 'CAD' || tz.includes('toronto') || tz.includes('vancouver')) {
    return 'CA';
  }
  if (curr === 'AUD' || tz.includes('sydney') || tz.includes('melbourne')) {
    return 'AU';
  }
  if (curr === 'JPY' || tz.includes('tokyo')) {
    return 'JP';
  }
  if (tz.includes('los_angeles') || label.includes('california') || label.includes('san francisco') || label.includes(', ca')) {
    return 'US-CA';
  }
  if (tz.includes('new_york') || label.includes('new york') || label.includes(', ny')) {
    return 'US-NY';
  }
  if (tz.includes('chicago') || label.includes('illinois') || label.includes(', il')) {
    return 'US-IL';
  }
  return null;
}

export const REGION_REQUIRED_MESSAGE =
  'Set your region to see local holidays. We could not work it out from your timezone or home location.';

occasionsRouter.get('/api/occasions', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const user = await profilesRepo.getById(authReq.userId);
    const currency = user?.currency ?? 'USD';
    const region = deriveRegion(user?.timezone, user?.currency, user?.home_label);

    const holidays = region ? await occasionsRepo.getHolidays(region) : [];
    const habits = await occasionsRepo.getHabitsForUser(authReq.userId);

    const weeklyPocket = await vaultRepo.getPocket(authReq.userId, 'weekly');
    const weekendBudgetMinor = weeklyPocket?.balance_minor ?? user?.guilt_free_cap_minor ?? 0;

    const holidayPocket = await vaultRepo.getPocket(authReq.userId, 'holiday');
    const holidayBudgetMinor = holidayPocket?.balance_minor ?? 0;

    const getawayPocket = await vaultRepo.getPocket(authReq.userId, 'getaway');
    const getawayFundMinor = getawayPocket?.balance_minor ?? 0;
    const minTripBudgetMinor = 45000; // $450.00
    const safetyMargin = 1.2;
    const isReadyForTrip = getawayFundMinor >= Math.ceil(minTripBudgetMinor * safetyMargin);

    const calendar = [
      {
        id: 'occ_1',
        type: 'everyday',
        title: habits.length > 0 ? `${habits[0]?.category ?? 'Friday'} Outing` : 'Friday Dinner Outing',
        date: 'This Friday',
        budgetMinor: habits[0]?.typical_amount_minor ?? 2200,
        budgetFormatted: moneyService.format(habits[0]?.typical_amount_minor ?? 2200, currency),
        note: 'Aligned with your usual Friday rhythm.'
      },
      {
        id: 'occ_2',
        type: 'weekend',
        title: 'Regular Weekend Outing',
        date: 'Saturday–Sunday',
        budgetMinor: weekendBudgetMinor,
        budgetFormatted: moneyService.format(weekendBudgetMinor, currency),
        note: 'Powered by this week’s free discretionary fun money.'
      },
      ...holidays.map((h) => ({
        id: h.id,
        type: 'holiday' as const,
        title: h.name,
        date: h.date,
        budgetMinor: holidayBudgetMinor,
        budgetFormatted: moneyService.format(holidayBudgetMinor, currency),
        note: 'Holiday pot allocated.'
      }))
    ];

    sendSuccess(
      res,
      {
        region,
        regionRequired: region === null,
        ...(region === null ? { regionMessage: REGION_REQUIRED_MESSAGE } : {}),
        calendar,
        habits: habits.map((h) => ({
          ...h,
          typicalAmountFormatted: moneyService.format(h.typical_amount_minor)
        })),
        getawayStatus: {
          fundMinor: getawayFundMinor,
          fundFormatted: moneyService.format(getawayFundMinor),
          isReady: isReadyForTrip,
          margin: safetyMargin,
          gapMinor: Math.max(0, Math.ceil(minTripBudgetMinor * safetyMargin) - getawayFundMinor)
        }
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const GetawayPlanSchema = z.object({
  nights: z.number().int().min(1).max(5).default(3)
});

occasionsRouter.post('/api/getaways/plan', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { nights } = GetawayPlanSchema.parse(req.body);

    const user = await profilesRepo.getById(authReq.userId);
    const region = deriveRegion(user?.timezone, user?.currency, user?.home_label);
    if (region === null) {
      sendError(res, 'REGION_REQUIRED', REGION_REQUIRED_MESSAGE, 422, undefined, authReq.requestId);
      return;
    }
    const pocket = await vaultRepo.getPocket(authReq.userId, 'getaway');
    const fundMinor = pocket?.balance_minor ?? 0;

    // Propose Getaway destinations via Gemini
    const proposed = await geminiService.proposeGetaways(region, nights);

    // Code computes estimated totals with 1.2 safety margin
    const trips = proposed.candidates.map((c, idx) => {
      const perDayMinor = 12000 + idx * 2500; // $120–$170/day
      const travelAllowanceMinor = 6000;      // $60 travel
      const totalMinor = perDayMinor * nights + travelAllowanceMinor;
      const totalWithMargin = Math.ceil(totalMinor * 1.2);
      const fitsFund = totalWithMargin <= fundMinor;

      return {
        id: `trip_${idx + 1}`,
        name: c.name,
        state: c.state,
        kind: c.kind,
        nights,
        travelHours: 3.5 + idx * 0.8,
        perDayMinor,
        perDayFormatted: moneyService.format(perDayMinor),
        totalMinor,
        totalFormatted: moneyService.format(totalMinor),
        fundSharePct: Math.round((totalMinor / fundMinor) * 100),
        fitsFund,
        whyItFits: c.whyItFits,
        disclaimer: 'Model estimate. Please verify prices and availability before booking.'
      };
    });

    sendSuccess(
      res,
      {
        getawayFundMinor: fundMinor,
        getawayFundFormatted: moneyService.format(fundMinor),
        recommendedTour: trips[0],
        alternativeTours: trips.slice(1)
      },
      authReq.requestId
    );
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
