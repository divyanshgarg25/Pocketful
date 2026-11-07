import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { UpstreamError } from '../core/errors.js';
import crypto from 'crypto';
import { z } from 'zod';

// 1. Zod Schemas for Gemini Outputs
export const CostEstimatesSchema = z.object({
  estimates: z.array(
    z
      .object({
        venue_id: z.string(),
        low: z.number().int().nonnegative(),
        high: z.number().int().nonnegative(),
        basis: z.string(),
        confidence: z.enum(['low', 'medium', 'high'])
      })
      .refine((data) => data.low <= data.high, {
        message: 'low must be <= high'
      })
  )
});
export type CostEstimatesOutput = z.infer<typeof CostEstimatesSchema>;

export const ReasoningCardsSchema = z.object({
  cards: z.array(
    z.object({
      slot: z.enum(['comfort', 'stretch', 'new']),
      venue_id: z.string(),
      headline: z.string(),
      why: z.string(),
      reason_tags: z.array(z.string())
    })
  )
});
export type ReasoningCardsOutput = z.infer<typeof ReasoningCardsSchema>;

export const TransactionClassificationSchema = z.object({
  items: z.array(
    z.object({
      txn_id: z.string(),
      category: z.string(),
      confidence: z.number().min(0).max(1)
    })
  )
});
export type TransactionClassificationOutput = z.infer<typeof TransactionClassificationSchema>;

export const GhostSubscriptionExplanationsSchema = z.object({
  explanations: z.array(
    z.object({
      subscription_id: z.string(),
      reason: z.string(),
      confidence: z.number().min(0).max(1)
    })
  )
});
export type GhostSubscriptionExplanationsOutput = z.infer<typeof GhostSubscriptionExplanationsSchema>;

export const GetawayCandidateSchema = z.object({
  candidates: z.array(
    z.object({
      name: z.string(),
      state: z.string(),
      country: z.string(),
      kind: z.enum(['hill', 'beach', 'heritage', 'nature']),
      approxLat: z.number(),
      approxLng: z.number(),
      whyItFits: z.string()
    })
  )
});
export type GetawayCandidateOutput = z.infer<typeof GetawayCandidateSchema>;

export class GeminiService {
  private cache = new Map<string, unknown>();

  private isDemo(): boolean {
    return (
      config.GEMINI_SIMULATE ||
      !config.GEMINI_API_KEY ||
      config.GEMINI_API_KEY.startsWith('demo-')
    );
  }

  private hashKey(prompt: string, input: unknown): string {
    const raw = `${prompt}:${JSON.stringify(input)}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Batched Cost Estimation for Venues
   */
  async estimateVenueCosts(
    venues: Array<{ id: string; name: string; category: string; tags: Record<string, unknown> }>
  ): Promise<CostEstimatesOutput> {
    const key = this.hashKey('estimate_costs', venues.map((v) => v.id));
    if (this.cache.has(key)) {
      return this.cache.get(key) as CostEstimatesOutput;
    }

    if (this.isDemo()) {
      // Golden demo fallback
      const estimates = venues.map((v) => {
        let low = 1000;
        let high = 2000;
        if (v.category === 'cafes') {
          low = 800;
          high = 1400;
        } else if (v.category === 'gaming') {
          low = 1200;
          high = 2000;
        } else if (v.category === 'sports') {
          low = 2200;
          high = 3000;
        } else if (v.category === 'workshops') {
          low = 3500;
          high = 4500;
        } else if (v.category === 'outdoors') {
          low = 0;
          high = 500;
        }
        return {
          venue_id: v.id,
          low,
          high,
          basis: 'Local average estimate based on category and tags',
          confidence: 'high' as const
        };
      });
      const result: CostEstimatesOutput = { estimates };
      this.cache.set(key, result);
      return result;
    }

    // Call Gemini API with structured prompt
    try {
      const prompt = `Estimate typical per-person cost ranges in ${config.DEFAULT_CURRENCY} for these venues: ${JSON.stringify(
        venues
      )}. Output strictly JSON matching: {"estimates":[{"venue_id":"string","low":0,"high":0,"basis":"string","confidence":"low|medium|high"}]}`;
      const raw = await this.callGemini(prompt);
      const parsed = CostEstimatesSchema.parse(JSON.parse(raw));
      this.cache.set(key, parsed);
      return parsed;
    } catch (err) {
      logger.warn('[GeminiService] Cost estimation failed, using deterministic template:', {
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        estimates: venues.map((v) => ({
          venue_id: v.id,
          low: 1000,
          high: 2500,
          basis: 'Default category template estimate',
          confidence: 'medium' as const
        }))
      };
    }
  }

  /**
   * Batched Reasoning Cards for Plan Slots (Comfort, Stretch, New)
   */
  async generateReasoningCards(
    slots: Array<{
      slot: 'comfort' | 'stretch' | 'new';
      venue_id: string;
      name: string;
      category: string;
      distKm: number;
      costRange: string;
      mood: string;
      userHistoryWhy: string;
    }>
  ): Promise<ReasoningCardsOutput> {
    const key = this.hashKey('reasoning_cards', slots);
    if (this.cache.has(key)) {
      return this.cache.get(key) as ReasoningCardsOutput;
    }

    if (this.isDemo()) {
      // Golden demo reasoning cards crafted in Pip's considerate bookkeeper voice
      const cards: ReasoningCardsOutput['cards'] = slots.map((s) => {
        if (s.slot === 'comfort') {
          return {
            slot: 'comfort',
            venue_id: s.venue_id,
            headline: 'A calm corner, close to home',
            why: `Fits your ${s.costRange} budget nicely. Shown because you chose ${s.category} yourself 3 times this month.`,
            reason_tags: ['within_budget', 'near', 'self_chosen']
          };
        } else if (s.slot === 'stretch') {
          return {
            slot: 'stretch',
            venue_id: s.venue_id,
            headline: 'A familiar rhythm with a new spin',
            why: `Within your reachable radius (${s.distKm} km). Takes your love for relaxed spots into a fresh evening venue.`,
            reason_tags: ['stretch_pick', 'moderate_distance', 'budget_aligned']
          };
        } else {
          return {
            slot: 'new',
            venue_id: s.venue_id,
            headline: 'Something completely fresh',
            why: `An untouched experience outside your recent ledger history, comfortably under your weekend cap.`,
            reason_tags: ['new_experience', 'growth_opportunity', 'guilt_free']
          };
        }
      });

      const result: ReasoningCardsOutput = { cards };
      this.cache.set(key, result);
      return result;
    }

    try {
      const prompt = `You are Pip, a calm bookkeeper who knows great local places. Write short reasoning cards for these 3 options: ${JSON.stringify(
        slots
      )}. Closed-world rule: reference ONLY the facts provided. Never invent numbers or venues. Output strictly JSON matching: {"cards":[{"slot":"comfort|stretch|new","venue_id":"string","headline":"string","why":"string","reason_tags":["string"]}]}`;
      const raw = await this.callGemini(prompt);
      const parsed = ReasoningCardsSchema.parse(JSON.parse(raw));
      this.cache.set(key, parsed);
      return parsed;
    } catch (err) {
      logger.warn('[GeminiService] Reasoning cards failed, using template:', {
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        cards: slots.map((s) => ({
          slot: s.slot,
          venue_id: s.venue_id,
          headline: `${s.name} (${s.category})`,
          why: `Well-suited for your ${s.mood} mood and ${s.costRange} budget.`,
          reason_tags: ['budget_aligned']
        }))
      };
    }
  }

  /**
   * Explain ghost subscriptions in plain language
   */
  async explainGhostSubscriptions(
    subs: Array<{ id: string; merchant: string; amountFormatted: string; daysUnused: number }>
  ): Promise<GhostSubscriptionExplanationsOutput> {
    const key = this.hashKey('ghost_explanations', subs);
    if (this.cache.has(key)) {
      return this.cache.get(key) as GhostSubscriptionExplanationsOutput;
    }

    if (!this.isDemo()) {
      try {
        const prompt = `Explain why these unused recurring subscriptions should be audited and cancelled: ${JSON.stringify(
          subs
        )}. Output strictly JSON matching: {"explanations":[{"subscription_id":"string","reason":"string","confidence":0.95}]}`;
        const raw = await this.callGemini(prompt);
        const parsed = GhostSubscriptionExplanationsSchema.parse(JSON.parse(raw));
        // Validate that subscription_ids correspond to input subs
        const validIds = new Set(subs.map((s) => s.id));
        const filtered = parsed.explanations.filter((e) => validIds.has(e.subscription_id));
        if (filtered.length === subs.length) {
          const result = { explanations: filtered };
          this.cache.set(key, result);
          return result;
        }
      } catch (err) {
        logger.warn('[GeminiService] Live explainGhostSubscriptions failed, using fallback:', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const explanations = subs.map((s) => ({
      subscription_id: s.id,
      reason: `No attendance or usage signal detected for ${s.daysUnused} days. Cancelling frees ${s.amountFormatted}/month.`,
      confidence: 0.95
    }));

    const result = { explanations };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Classify unknown transaction merchants into categories
   */
  async classifyTransactions(
    items: Array<{ txn_id: string; merchant_raw: string; amount_minor: number }>
  ): Promise<TransactionClassificationOutput> {
    const key = this.hashKey('classify_txns', items);
    if (this.cache.has(key)) {
      return this.cache.get(key) as TransactionClassificationOutput;
    }

    if (!this.isDemo()) {
      try {
        const prompt = `Classify these transaction merchants into categories (cafes, sports, gaming, workshops, arts, outdoors): ${JSON.stringify(
          items
        )}. Output strictly JSON matching: {"items":[{"txn_id":"string","category":"string","confidence":0.85}]}`;
        const raw = await this.callGemini(prompt);
        const parsed = TransactionClassificationSchema.parse(JSON.parse(raw));
        const validTxnIds = new Set(items.map((i) => i.txn_id));
        const filtered = parsed.items.filter((i) => validTxnIds.has(i.txn_id));
        if (filtered.length === items.length) {
          const result = { items: filtered };
          this.cache.set(key, result);
          return result;
        }
      } catch (err) {
        logger.warn('[GeminiService] Live classifyTransactions failed, using fallback:', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const classified = items.map((i) => {
      const raw = i.merchant_raw.toLowerCase();
      let category = 'cafes';
      if (raw.includes('climb') || raw.includes('gym') || raw.includes('boulder')) category = 'sports';
      else if (raw.includes('arcade') || raw.includes('game') || raw.includes('board')) category = 'gaming';
      else if (raw.includes('ceramic') || raw.includes('clay') || raw.includes('pottery')) category = 'workshops';
      else if (raw.includes('cinema') || raw.includes('film') || raw.includes('theater')) category = 'arts';
      else if (raw.includes('park') || raw.includes('trail')) category = 'outdoors';

      return {
        txn_id: i.txn_id,
        category,
        confidence: 0.85
      };
    });

    const result = { items: classified };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Propose Getaway destinations
   */
  async proposeGetaways(homeRegion: string, nights: number): Promise<GetawayCandidateOutput> {
    const key = this.hashKey('getaway_destinations', { homeRegion, nights });
    if (this.cache.has(key)) {
      return this.cache.get(key) as GetawayCandidateOutput;
    }

    if (!this.isDemo()) {
      try {
        const prompt = `Propose 3 relaxing weekend getaway destinations within 3 hours from ${homeRegion} for a ${nights}-night stay. Output strictly JSON matching: {"candidates":[{"name":"string","state":"string","country":"string","kind":"nature|beach|city|mountain|hill","approxLat":0.0,"approxLng":0.0,"whyItFits":"string"}]}`;
        const raw = await this.callGemini(prompt);
        const parsed = GetawayCandidateSchema.parse(JSON.parse(raw));
        if (parsed.candidates.length > 0) {
          this.cache.set(key, parsed);
          return parsed;
        }
      } catch (err) {
        logger.warn('[GeminiService] Live proposeGetaways failed, using fallback:', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const candidates: GetawayCandidateOutput['candidates'] = [
      {
        name: 'Carmel-by-the-Sea',
        state: 'California',
        country: 'USA',
        kind: 'beach',
        approxLat: 36.5552,
        approxLng: -121.9233,
        whyItFits: 'Peaceful seaside escape with artisan bakeries and quiet pine trails.'
      },
      {
        name: 'Napa Valley Foothills',
        state: 'California',
        country: 'USA',
        kind: 'nature',
        approxLat: 38.2975,
        approxLng: -122.2869,
        whyItFits: 'Scenic valley cycling, vineyard picnics, and quiet evenings.'
      },
      {
        name: 'Lake Tahoe North Shore',
        state: 'California',
        country: 'USA',
        kind: 'hill',
        approxLat: 39.1726,
        approxLng: -120.1416,
        whyItFits: 'Alpine pine forest, lake kayaking, and crisp mountain air.'
      }
    ];

    const result = { candidates };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Direct Gemini API invocation via REST with official Google GenAI endpoint
   */
  private async callGemini(prompt: string): Promise<string> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2
      }
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (config.GEMINI_API_KEY) {
      headers['x-goog-api-key'] = config.GEMINI_API_KEY;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000) // 8-second timeout guard
    });

    if (!res.ok) {
      throw new UpstreamError(`[Gemini API] Call failed (${res.status}): ${await res.text()}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new UpstreamError('[Gemini API] Empty candidate response');

    // Strip markdown code fences if LLM wrapped JSON response
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    return cleaned;
  }
}

export const geminiService = new GeminiService();
