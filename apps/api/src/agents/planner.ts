import { profilesRepo } from '../repos/profiles.js';
import { vaultRepo } from '../repos/vault.js';
import { placesService } from '../services/places.js';
import { geminiService } from '../services/gemini.js';
import { learnerAgent } from './learner.js';
import { banditRepo } from '../repos/bandit.js';
import { plansRepo } from '../repos/plans.js';
import { suggestionsRepo } from '../repos/suggestions.js';
import { auditRepo } from '../repos/audit.js';
import { eventBus } from '../core/events.js';
import { moneyService } from '../services/money.js';
import { ValidationError, NotFoundError } from '../core/errors.js';
import type { Plan, Suggestion, Venue } from '../schemas/domain.js';
import crypto from 'crypto';

export interface PlanSlotResult {
  slot: 'comfort' | 'stretch' | 'new';
  suggestionId: string;
  venue: Venue;
  distKm: number;
  costLowMinor: number;
  costHighMinor: number;
  costBasis: string;
  headline: string;
  why: string;
  reasonTags: string[];
}

export interface GeneratedPlanResult {
  planId: string;
  budgetMinor: number;
  budgetFormatted: string;
  mood: 'drained' | 'okay' | 'great';
  groupSize: number;
  radiusKm: number;
  slots: PlanSlotResult[];
  notes: string[];
}

export class PlannerAgent {
  readonly name = 'planner';

  /**
   * Execute the Closed-World 3-Slot Planning Pipeline
   */
  async generatePlan(
    userId: string,
    options: {
      mood?: 'drained' | 'okay' | 'great';
      groupSize?: number;
      radiusKm?: number;
      occasionType?: 'everyday' | 'weekend' | 'holiday' | 'getaway';
      requestId?: string;
    } = {}
  ): Promise<GeneratedPlanResult> {
    const user = await profilesRepo.getById(userId);
    if (!user) throw new NotFoundError('User profile not found.');

    const prefs = await profilesRepo.getPreferences(userId);
    const interests = prefs?.interests ?? ['cafes', 'gaming', 'sports', 'outdoors'];
    const mood = user.opt_in_mood
      ? (options.mood ?? (await vaultRepo.getLatestMoodCheckin(userId))?.level ?? 'okay')
      : 'okay';
    const groupSize = options.groupSize ?? 1;
    let radiusKm = options.radiusKm ?? Number(user.max_distance_km);

    let lat = user.home_lat;
    let lng = user.home_lng;
    if (lat == null || lng == null) {
      if (user.home_label) {
        try {
          const geo = await placesService.geocodeAddress(user.home_label);
          lat = geo.lat;
          lng = geo.lng;
        } catch {
          // Unresolvable label
        }
      }
    }
    if (lat == null || lng == null) {
      throw new ValidationError(
        'Home location (home_lat, home_lng, or home_label) must be configured in your profile to plan outings.'
      );
    }

    // 1. Compute available budget
    const weeklyPocket = await vaultRepo.getPocket(userId, 'weekly');
    const availableFunMoney = weeklyPocket?.balance_minor ?? user.guilt_free_cap_minor ?? 0;
    const budgetMinor = moneyService.computeFunMoney(
      availableFunMoney,
      0,
      0,
      0,
      user.guilt_free_cap_minor
    );

    const notes: string[] = [];

    // 2. Fetch Venues within radius
    let rawVenues = await placesService.findNearbyVenues(lat, lng, radiusKm, interests);

    // 3. Batch Cost Estimates
    const costResults = await geminiService.estimateVenueCosts(
      rawVenues.map((v) => ({
        id: v.id,
        name: v.name,
        category: v.category,
        tags: v.tags
      }))
    );

    const estimateMap = new Map<string, { low: number; high: number; basis: string }>();
    for (const est of costResults.estimates) {
      estimateMap.set(est.venue_id, { low: est.low, high: est.high, basis: est.basis });
    }

    // 4. Hard Filter: Distance & Budget
    const evaluateSurvivors = (venues: Venue[], rKm: number) => {
      return venues
        .map((v) => {
          const distKm = placesService.roadDistanceKm(lat, lng, v.lat, v.lng);
          const est = estimateMap.get(v.id) ?? {
            low: v.est_cost_low_minor ?? 800,
            high: v.est_cost_high_minor ?? 1500,
            basis: 'estimate'
          };
          return {
            venue: v,
            distKm,
            costLowMinor: est.low,
            costHighMinor: est.high,
            costBasis: est.basis,
            features: learnerAgent.extractFeatures(v, distKm, budgetMinor, mood)
          };
        })
        .filter((item) => {
          const withinDistance = item.distKm <= rKm;
          const fitsBudget = item.costHighMinor * groupSize <= budgetMinor;
          return withinDistance && fitsBudget;
        });
    };

    let survivors = evaluateSurvivors(rawVenues, radiusKm);

    // Edge handling: if <3 venues, widen radius once by 1.5x
    if (survivors.length > 0 && survivors.length < 3) {
      const widenedRadius = Math.round(radiusKm * 1.5 * 10) / 10;
      notes.push(`Few places fit within ${radiusKm} km. Widened reach to ${widenedRadius} km.`);
      radiusKm = widenedRadius;
      rawVenues = await placesService.findNearbyVenues(lat, lng, radiusKm, interests);
      survivors = evaluateSurvivors(rawVenues, radiusKm);
    }

    // 5. Score survivors with Thompson Sampling
    const stateMap = await banditRepo.getBanditStateForUser(userId);
    const scored = survivors.map((s) => ({
      ...s,
      thompsonScore: learnerAgent.score(s.features, stateMap)
    }));
    scored.sort((a, b) => b.thompsonScore - a.thompsonScore);

    // 6. Build Distinct Slots: Comfort, Stretch, New Experience
    let slotOrder: Array<{
      slot: 'comfort' | 'stretch' | 'new';
      item: (typeof scored)[0];
    }> = [];

    if (scored.length === 0) {
      notes.push('No venues found matching budget and criteria.');
    } else if (scored.length === 1) {
      notes.push('Limited venues available; returning 1 distinct plan slot.');
      slotOrder = [{ slot: 'comfort', item: scored[0]! }];
    } else if (scored.length === 2) {
      notes.push('Limited venues available; returning 2 distinct plan slots.');
      if (mood === 'great') {
        slotOrder = [
          { slot: 'stretch', item: scored[1]! },
          { slot: 'comfort', item: scored[0]! }
        ];
      } else {
        slotOrder = [
          { slot: 'comfort', item: scored[0]! },
          { slot: 'stretch', item: scored[1]! }
        ];
      }
    } else {
      // 3 or more distinct venues available
      const comfortCandidate = scored[0]!;
      const remaining = scored.slice(1);

      // Stretch: vary exactly one feature (e.g. distance band or category)
      let stretchCandidate = remaining.find((r) => {
        let diffCount = 0;
        for (const [k, v] of Object.entries(r.features)) {
          if (comfortCandidate.features[k] !== v) diffCount++;
        }
        return diffCount === 1;
      });
      if (!stretchCandidate) {
        stretchCandidate = remaining[0]!;
      }

      // New Experience: Highest novelty among remaining distinct venues
      const restForNew = remaining.filter((r) => r.venue.id !== stretchCandidate!.venue.id);
      const featureCounts: Record<string, number> = {};
      for (const [k, v] of Object.entries(comfortCandidate.features)) {
        featureCounts[`${k}:${v}`] = (featureCounts[`${k}:${v}`] ?? 0) + 1;
      }

      let novelCandidate = restForNew.sort((a, b) => {
        const na = learnerAgent.noveltyScore(a.features, featureCounts);
        const nb = learnerAgent.noveltyScore(b.features, featureCounts);
        return nb - na;
      })[0];

      if (!novelCandidate) {
        novelCandidate = restForNew[0] ?? remaining[1]!;
      }

      // 7. Order Slots by Mood
      if (mood === 'drained') {
        slotOrder = [
          { slot: 'comfort', item: comfortCandidate },
          { slot: 'new', item: novelCandidate },
          { slot: 'stretch', item: stretchCandidate }
        ];
        notes.push('Rough week detected. Calmer, lower-effort ideas lead your plan.');
      } else if (mood === 'great') {
        slotOrder = [
          { slot: 'stretch', item: stretchCandidate },
          { slot: 'new', item: novelCandidate },
          { slot: 'comfort', item: comfortCandidate }
        ];
        notes.push('Great energy noted. Leading with stretch exploration.');
      } else {
        slotOrder = [
          { slot: 'comfort', item: comfortCandidate },
          { slot: 'stretch', item: stretchCandidate },
          { slot: 'new', item: novelCandidate }
        ];
      }
    }

    // 8. Generate Reasoning Cards using Gemini (Closed-World)
    const reasoningPayload = slotOrder.map((s) => ({
      slot: s.slot,
      venue_id: s.item.venue.id,
      name: s.item.venue.name,
      category: s.item.venue.category,
      distKm: s.item.distKm,
      costRange: `${moneyService.format(s.item.costLowMinor)}–${moneyService.format(s.item.costHighMinor)}`,
      mood,
      userHistoryWhy: `Fits budget and aligns with past choices.`
    }));

    const reasoningCardsResult = await geminiService.generateReasoningCards(reasoningPayload);
    const cardMap = new Map<string, { headline: string; why: string; reason_tags: string[] }>();
    for (const c of reasoningCardsResult.cards) {
      cardMap.set(c.venue_id, { headline: c.headline, why: c.why, reason_tags: c.reason_tags });
    }

    // 9. Persist Plan and Suggestions in Database
    const planId = crypto.randomUUID();
    const planWeek = new Date().toISOString().slice(0, 10);

    const plan: Plan = {
      id: planId,
      user_id: userId,
      week: planWeek,
      mood,
      group_size: groupSize,
      budget_minor: budgetMinor,
      radius_km: radiusKm,
      status: 'open',
      occasion_type: options.occasionType ?? 'weekend',
      created_at: new Date().toISOString()
    };
    await plansRepo.create(plan);

    const suggestionsToCreate: Suggestion[] = [];
    const slotsResult: PlanSlotResult[] = [];

    for (const s of slotOrder) {
      const suggestionId = crypto.randomUUID();
      const card = cardMap.get(s.item.venue.id) ?? {
        headline: s.item.venue.name,
        why: `Within your ${radiusKm} km radius and fits your ${moneyService.format(budgetMinor)} budget.`,
        reason_tags: ['within_budget']
      };

      const suggestion: Suggestion = {
        id: suggestionId,
        user_id: userId,
        plan_id: planId,
        venue_id: s.item.venue.id,
        slot: s.slot,
        features: s.item.features,
        headline: card.headline,
        why: card.why,
        reason_tags: card.reason_tags,
        shown_at: new Date().toISOString()
      };

      suggestionsToCreate.push(suggestion);

      slotsResult.push({
        slot: s.slot,
        suggestionId,
        venue: s.item.venue,
        distKm: s.item.distKm,
        costLowMinor: s.item.costLowMinor,
        costHighMinor: s.item.costHighMinor,
        costBasis: s.item.costBasis,
        headline: card.headline,
        why: card.why,
        reasonTags: card.reason_tags
      });
    }

    await suggestionsRepo.createBatch(suggestionsToCreate);

    await auditRepo.log({
      user_id: userId,
      request_id: options.requestId,
      agent: this.name,
      action: 'plan_generated',
      params: { planId, mood, groupSize, budgetMinor, radiusKm },
      result: { slotsCount: slotsResult.length }
    });

    eventBus.emitEvent('plan.generated', { plan, suggestions: suggestionsToCreate });

    return {
      planId,
      budgetMinor,
      budgetFormatted: moneyService.format(budgetMinor),
      mood,
      groupSize,
      radiusKm,
      slots: slotsResult,
      notes
    };
  }
}

export const plannerAgent = new PlannerAgent();
