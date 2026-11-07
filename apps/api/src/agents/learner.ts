import jStat from 'jstat';
import { banditRepo } from '../repos/bandit.js';
import type { BanditState, Venue } from '../schemas/domain.js';
import crypto from 'crypto';

export type EventType =
  | 'followed'
  | 'organic'
  | 'organic_worth_it'
  | 'organic_okay'
  | 'organic_too_much'
  | 'modified'
  | 'ignored';

export type RejectReason = 'too_far' | 'too_pricey' | 'not_my_vibe' | 'did_recently';

export interface LearnedLine {
  id: string;
  feature: string;
  text: string;
  evidence: string;
}

export class LearnerAgent {
  readonly name = 'learner';

  private featureWeights: Record<string, number> = {
    category: 1.5,
    price_band: 1.2,
    distance_band: 1.0,
    mood_context: 1.3,
    day: 0.8,
    social: 0.9
  };

  private eventWeights: Record<EventType, number> = {
    followed: 1.0,
    organic: 1.2,
    organic_worth_it: 1.5,
    organic_okay: 1.0,
    organic_too_much: 0.0, // Handled specifically: price_band beta + 1.0, category unpenalized
    modified: 0.5,
    ignored: -0.1
  };

  /**
   * Determine price band relative to free discretionary money
   */
  classifyPriceBand(costHighMinor: number, funMoneyMinor: number): 'low' | 'mid' | 'high' {
    if (funMoneyMinor <= 0) return 'mid';
    const ratio = costHighMinor / funMoneyMinor;
    if (ratio < 0.15) return 'low';
    if (ratio <= 0.35) return 'mid';
    return 'high';
  }

  /**
   * Determine distance band
   */
  classifyDistanceBand(distKm: number): '0-2km' | '2-5km' | '5-10km' | '10+km' {
    if (distKm <= 2) return '0-2km';
    if (distKm <= 5) return '2-5km';
    if (distKm <= 10) return '5-10km';
    return '10+km';
  }

  /**
   * Extract features map for a candidate venue
   */
  extractFeatures(
    venue: Venue,
    distKm: number,
    funMoneyMinor: number,
    mood = 'okay'
  ): Record<string, string> {
    const costHigh = venue.est_cost_high_minor ?? 1500;
    return {
      category: venue.category,
      price_band: this.classifyPriceBand(costHigh, funMoneyMinor),
      distance_band: this.classifyDistanceBand(distKm),
      mood_context: mood
    };
  }

  /**
   * Score candidate venue using Thompson Sampling over the Beta distribution
   * Score = sum(weight_f * sample(alpha_f, beta_f))
   */
  score(venueFeatures: Record<string, string>, stateMap: Map<string, BanditState>): number {
    let totalScore = 0;

    for (const [feature, value] of Object.entries(venueFeatures)) {
      const key = `${feature}:${value}`;
      const state = stateMap.get(key) ?? { alpha: 1, beta: 1 };
      const weight = this.featureWeights[feature] ?? 1.0;

      // Sample from Beta distribution using jstat
      const sample = jStat.beta.sample(Math.max(1, state.alpha), Math.max(1, state.beta));
      totalScore += weight * sample;
    }

    return totalScore;
  }

  /**
   * Compute novelty score: average 1 / (1 + count(f=val in history))
   */
  noveltyScore(venueFeatures: Record<string, string>, featureCounts: Record<string, number>): number {
    const entries = Object.entries(venueFeatures);
    if (entries.length === 0) return 1.0;

    let sum = 0;
    for (const [f, val] of entries) {
      const key = `${f}:${val}`;
      const count = featureCounts[key] ?? 0;
      sum += 1 / (1 + count);
    }
    return sum / entries.length;
  }

  /**
   * Update bandit state after an outcome event
   */
  async applyEvent(
    userId: string,
    features: Record<string, string>,
    type: EventType,
    repeatCount = 0,
    confidence = 1.0
  ): Promise<void> {
    const baseWeight = this.eventWeights[type];
    const repeatBonus = Math.min(0.2 * repeatCount, 0.6);
    const weight = (baseWeight + (baseWeight > 0 ? repeatBonus : 0)) * confidence;

    // 1. Log immutable learning event
    await banditRepo.logEvent({
      id: crypto.randomUUID(),
      user_id: userId,
      event_type: type,
      weight,
      features,
      confidence,
      reverted: false,
      created_at: new Date().toISOString()
    });

    // 2. Project into bandit_state
    const stateMap = await banditRepo.getBanditStateForUser(userId);

    for (const [f, val] of Object.entries(features)) {
      const key = `${f}:${val}`;
      const current = stateMap.get(key) ?? {
        user_id: userId,
        feature: f,
        value: val,
        alpha: 1,
        beta: 1
      };

      if (type === 'organic_too_much') {
        if (f === 'category') {
          // User enjoyed the category (e.g. coffee) but disliked the price.
          // Leave category unpenalized or mildly positive (+0.2).
          const mildPositive = 0.2 * confidence;
          const updated = {
            ...current,
            alpha: Math.min(200, Math.max(1, current.alpha + mildPositive)),
            beta: Math.min(200, Math.max(1, current.beta)),
            updated_at: new Date().toISOString()
          };
          await banditRepo.saveBanditState(updated);
          continue;
        }

        if (f === 'price_band') {
          // Only penalize the price band (+1.0 to beta)
          const updated = {
            ...current,
            alpha: Math.min(200, Math.max(1, current.alpha)),
            beta: Math.min(200, Math.max(1, current.beta + 1.0 * confidence)),
            updated_at: new Date().toISOString()
          };
          await banditRepo.saveBanditState(updated);
          continue;
        }
      }

      const newAlpha = weight > 0 ? current.alpha + weight : current.alpha;
      const newBeta = weight < 0 ? current.beta + Math.abs(weight) : current.beta;

      const updated = {
        ...current,
        alpha: Math.min(200, Math.max(1, newAlpha)),
        beta: Math.min(200, Math.max(1, newBeta)),
        updated_at: new Date().toISOString()
      };

      await banditRepo.saveBanditState(updated);
    }
  }

  /**
   * Revert bandit state when a past rating/event is corrected or updated
   */
  async revertEvent(
    userId: string,
    features: Record<string, string>,
    type: EventType,
    repeatCount = 0,
    confidence = 1.0
  ): Promise<void> {
    const baseWeight = this.eventWeights[type];
    const repeatBonus = Math.min(0.2 * repeatCount, 0.6);
    const weight = (baseWeight + (baseWeight > 0 ? repeatBonus : 0)) * confidence;

    // 1. Log immutable learning event as revert
    await banditRepo.logEvent({
      id: crypto.randomUUID(),
      user_id: userId,
      event_type: `revert_${type}`,
      weight: -weight,
      features,
      confidence,
      reverted: true,
      created_at: new Date().toISOString()
    });

    // 2. Project rollback into bandit_state
    const stateMap = await banditRepo.getBanditStateForUser(userId);

    for (const [f, val] of Object.entries(features)) {
      const key = `${f}:${val}`;
      const current = stateMap.get(key);
      if (!current) continue;

      if (type === 'organic_too_much') {
        if (f === 'category') {
          const mildPositive = 0.2 * confidence;
          const updated = {
            ...current,
            alpha: Math.min(200, Math.max(1, current.alpha - mildPositive)),
            beta: Math.min(200, Math.max(1, current.beta)),
            updated_at: new Date().toISOString()
          };
          await banditRepo.saveBanditState(updated);
          continue;
        }

        if (f === 'price_band') {
          const updated = {
            ...current,
            alpha: Math.min(200, Math.max(1, current.alpha)),
            beta: Math.min(200, Math.max(1, current.beta - 1.0 * confidence)),
            updated_at: new Date().toISOString()
          };
          await banditRepo.saveBanditState(updated);
          continue;
        }
      }

      const newAlpha = weight > 0 ? current.alpha - weight : current.alpha;
      const newBeta = weight < 0 ? current.beta - Math.abs(weight) : current.beta;

      const updated = {
        ...current,
        alpha: Math.min(200, Math.max(1, newAlpha)),
        beta: Math.min(200, Math.max(1, newBeta)),
        updated_at: new Date().toISOString()
      };

      await banditRepo.saveBanditState(updated);
    }
  }

  /**
   * Recompute bandit state from active learning events.
   * Invoked after forget or reset actions.
   */
  async recomputeBanditState(userId: string): Promise<void> {
    // 1. Reset state to priors
    await banditRepo.resetAllForUser(userId);
    // 2. Fetch all non-reverted learning events in chronological order
    const events = await banditRepo.getEventsForUser(userId, false);
    const chronological = [...events].sort(
      (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
    );

    // 3. Replay each active event into bandit_state
    const stateMap = await banditRepo.getBanditStateForUser(userId);
    for (const evt of chronological) {
      const type = evt.event_type as EventType;
      const weight = evt.weight;
      const confidence = evt.confidence;
      for (const [f, val] of Object.entries(evt.features)) {
        const key = `${f}:${val}`;
        const current = stateMap.get(key) ?? {
          user_id: userId,
          feature: f,
          value: String(val),
          alpha: 1,
          beta: 1
        };

        if (type === 'organic_too_much') {
          if (f === 'category') {
            const mildPositive = 0.2 * confidence;
            const updated = {
              ...current,
              alpha: Math.min(200, Math.max(1, current.alpha + mildPositive)),
              beta: Math.min(200, Math.max(1, current.beta)),
              updated_at: new Date().toISOString()
            };
            stateMap.set(key, updated);
            await banditRepo.saveBanditState(updated);
            continue;
          }
          if (f === 'price_band') {
            const updated = {
              ...current,
              alpha: Math.min(200, Math.max(1, current.alpha)),
              beta: Math.min(200, Math.max(1, current.beta + 1.0 * confidence)),
              updated_at: new Date().toISOString()
            };
            stateMap.set(key, updated);
            await banditRepo.saveBanditState(updated);
            continue;
          }
        }

        const newAlpha = weight > 0 ? current.alpha + weight : current.alpha;
        const newBeta = weight < 0 ? current.beta + Math.abs(weight) : current.beta;
        const updated = {
          ...current,
          alpha: Math.min(200, Math.max(1, newAlpha)),
          beta: Math.min(200, Math.max(1, newBeta)),
          updated_at: new Date().toISOString()
        };
        stateMap.set(key, updated);
        await banditRepo.saveBanditState(updated);
      }
    }
  }

  /**
   * Apply reasoned rejection: updates ONLY the named feature
   */
  async applyRejection(
    userId: string,
    features: Record<string, string>,
    reason: RejectReason
  ): Promise<void> {
    const targetFeatureMap: Record<RejectReason, string> = {
      too_far: 'distance_band',
      too_pricey: 'price_band',
      not_my_vibe: 'category',
      did_recently: 'category'
    };

    const targetFeature = targetFeatureMap[reason];
    const targetValue = features[targetFeature];

    if (!targetValue) return;

    // Log learning event
    await banditRepo.logEvent({
      id: crypto.randomUUID(),
      user_id: userId,
      event_type: `reject_${reason}`,
      weight: -1.5,
      features: { [targetFeature]: targetValue },
      confidence: 1.0,
      reverted: false,
      created_at: new Date().toISOString()
    });

    const stateMap = await banditRepo.getBanditStateForUser(userId);
    const key = `${targetFeature}:${targetValue}`;
    const current = stateMap.get(key) ?? {
      user_id: userId,
      feature: targetFeature,
      value: targetValue,
      alpha: 1,
      beta: 1
    };

    const penalty = reason === 'did_recently' ? 0.8 : 1.5;
    await banditRepo.saveBanditState({
      ...current,
      alpha: Math.min(200, Math.max(1, current.alpha)),
      beta: Math.min(200, Math.max(1, current.beta + penalty)),
      updated_at: new Date().toISOString()
    });
  }

  /**
   * Nightly decay: decays evidence (alpha - 1 and beta - 1) by 2% towards the neutral prior
   */
  async decay(userId: string): Promise<void> {
    const stateMap = await banditRepo.getBanditStateForUser(userId);
    for (const state of stateMap.values()) {
      const newAlpha = 1 + (state.alpha - 1) * 0.98;
      const newBeta = 1 + (state.beta - 1) * 0.98;
      await banditRepo.saveBanditState({
        ...state,
        alpha: Math.min(200, Math.max(1, newAlpha)),
        beta: Math.min(200, Math.max(1, newBeta)),
        updated_at: new Date().toISOString()
      });
    }
  }

  /**
   * Generate human-readable "What I've Learned About You" statements
   */
  async getLearnedLines(userId: string): Promise<LearnedLine[]> {
    const stateMap = await banditRepo.getBanditStateForUser(userId);
    const events = await banditRepo.getEventsForUser(userId);
    const lines: LearnedLine[] = [];

    // 1. Top categories
    const categories: Array<{ val: string; mean: number }> = [];
    for (const [k, s] of stateMap.entries()) {
      if (k.startsWith('category:')) {
        const mean = s.alpha / (s.alpha + s.beta);
        categories.push({ val: s.value, mean });
      }
    }
    categories.sort((a, b) => b.mean - a.mean);
    if (categories.length > 0 && categories[0]) {
      const top = categories[0].val;
      const count = events.filter((e) => e.features['category'] === top && !e.reverted).length;
      lines.push({
        id: 'learned_cat',
        feature: 'category',
        text: `You lean strongly towards ${top} for relaxed outings.`,
        evidence: count > 0
          ? `Selected or visited ${count} ${count === 1 ? 'time' : 'times'} across your ledger history.`
          : `Prior preference seeded based on your onboarding profile.`
      });
    }

    // 2. Price comfort
    const priceHigh = stateMap.get('price_band:high');
    const priceMid = stateMap.get('price_band:mid');
    if (priceHigh && priceHigh.beta > priceHigh.alpha) {
      lines.push({
        id: 'learned_price',
        feature: 'price_band',
        text: 'You prefer outings to stay under 35% of your available fun money.',
        evidence: 'High-cost options were penalized in past evaluations.'
      });
    } else if (priceMid) {
      lines.push({
        id: 'learned_price',
        feature: 'price_band',
        text: 'You are most comfortable with moderate prices ($10–$25 per person).',
        evidence: 'Consistent positive ratings on mid-tier plans.'
      });
    }

    // 3. Distance sensitivity
    const distClose = stateMap.get('distance_band:0-2km');
    const distMid = stateMap.get('distance_band:2-5km');
    if (distClose && distClose.alpha > distClose.beta) {
      lines.push({
        id: 'learned_dist',
        feature: 'distance_band',
        text: 'You value proximity: places within 2–5 km get prioritized first.',
        evidence: 'Past trips show higher acceptance within 15 minutes travel.'
      });
    } else if (distMid) {
      lines.push({
        id: 'learned_dist',
        feature: 'distance_band',
        text: 'Comfortable traveling up to 5 km from home for the right spot.',
        evidence: 'Based on your home address and distance preferences.'
      });
    }

    return lines;
  }
}

export const learnerAgent = new LearnerAgent();
