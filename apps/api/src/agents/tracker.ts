import Fuse from 'fuse.js';
import { transactionsRepo } from '../repos/transactions.js';
import { suggestionsRepo } from '../repos/suggestions.js';
import { venuesRepo } from '../repos/venues.js';
import { occasionsRepo } from '../repos/occasions.js';
import { geminiService } from '../services/gemini.js';
import { learnerAgent } from './learner.js';
import { eventBus } from '../core/events.js';
import { auditRepo } from '../repos/audit.js';
import type { Transaction, Habit } from '../schemas/domain.js';
import crypto from 'crypto';

export class TrackerAgent {
  readonly name = 'tracker';

  /**
   * Normalize merchant string for matching
   */
  normalizeMerchant(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/^(paypal\s*\*|sq\s*\*|tst\s*\*)/i, '')
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
  }

  /**
   * Determine if transaction is essential living expense vs leisure
   */
  isEssential(merchantRaw: string): boolean {
    const raw = merchantRaw.toLowerCase();
    const essentials = [
      'rent',
      'landlord',
      'groceries',
      'safeway',
      'trader joe',
      'whole foods',
      'electric',
      'utility',
      'pge',
      'water',
      'conedison',
      'pharmacy',
      'cvs',
      'walgreens',
      'hospital'
    ];
    return essentials.some((e) => raw.includes(e));
  }

  /**
   * Process and match an ingested transaction through the 4-tier cascade
   */
  async matchTransaction(txn: Transaction, userId: string): Promise<Transaction> {
    const norm = this.normalizeMerchant(txn.merchant_raw);

    // Essential check
    if (this.isEssential(txn.merchant_raw)) {
      const updated = await transactionsRepo.updateMatch(txn.id, 'ignored', 1.0, undefined, undefined, 'essential');
      return updated ?? txn;
    }

    // Tier 1: Link to an accepted suggestion within 48h and 25% amount tolerance
    const txnTime = new Date(txn.occurred_at).getTime();
    const sinceTime = new Date(txnTime - 48 * 3600000).toISOString();
    const acceptedSuggestions = await suggestionsRepo.getAcceptedForUser(userId, sinceTime);

    let followedSuggestionId: string | null = null;
    let followedVenueId: string | null = null;

    for (const s of acceptedSuggestions) {
      const shownOrDecided = s.shown_at || s.decided_at;
      if (shownOrDecided) {
        const timeDiff = Math.abs(txnTime - new Date(shownOrDecided).getTime());
        if (timeDiff <= 48 * 3600000) {
          const v = await venuesRepo.getById(s.venue_id);
          if (v) {
            const vNorm = this.normalizeMerchant(v.name);
            if (norm.includes(vNorm) || vNorm.includes(norm)) {
              if (v.est_cost_low_minor && v.est_cost_high_minor) {
                const lowWithTol = v.est_cost_low_minor * 0.75;
                const highWithTol = v.est_cost_high_minor * 1.25;
                if (txn.amount_minor >= lowWithTol && txn.amount_minor <= highWithTol) {
                  followedSuggestionId = s.id;
                  followedVenueId = v.id;
                  break;
                }
              } else {
                followedSuggestionId = s.id;
                followedVenueId = v.id;
                break;
              }
            }
          }
        }
      }
    }

    if (followedSuggestionId && followedVenueId) {
      const updated = await transactionsRepo.updateMatch(
        txn.id,
        'followed',
        0.9,
        followedVenueId,
        followedSuggestionId,
        txn.category ?? 'cafes'
      );
      if (updated) {
        await learnerAgent.applyEvent(
          userId,
          { category: updated.category ?? 'cafes' },
          'followed',
          0,
          0.9
        );
        eventBus.emitEvent('transaction.matched', { transaction: updated });
        return updated;
      }
    }

    // Tier 2: Fuzzy Venue Match using Fuse.js
    const allVenues = await venuesRepo.getAll();
    const fuse = new Fuse(allVenues, {
      keys: ['name'],
      threshold: 0.25,
      includeScore: true
    });

    const searchResults = fuse.search(norm);
    if (searchResults.length > 0 && searchResults[0]) {
      const best = searchResults[0];
      const score = best.score ?? 0;
      if (score <= 0.2) {
        const matchedVenue = best.item;
        const confidence = 1 - score;
        const updated = await transactionsRepo.updateMatch(
          txn.id,
          'organic',
          confidence,
          matchedVenue.id,
          undefined,
          matchedVenue.category
        );
        if (updated) {
          await learnerAgent.applyEvent(
            userId,
            { category: matchedVenue.category },
            'organic',
            0,
            confidence
          );
          eventBus.emitEvent('transaction.matched', { transaction: updated });
          return updated;
        }
      }
    }

    // Tier 3: Batched Gemini Category Classification
    const classificationResult = await geminiService.classifyTransactions([
      { txn_id: txn.id, merchant_raw: txn.merchant_raw, amount_minor: txn.amount_minor }
    ]);

    const itemClass = classificationResult.items[0];
    const category = itemClass?.category ?? 'cafes';
    const confidence = itemClass?.confidence ?? 0.7;

    const updated = await transactionsRepo.updateMatch(
      txn.id,
      'organic',
      confidence,
      undefined,
      undefined,
      category
    );

    if (updated) {
      // If confidence >= 0.6, apply learning
      if (confidence >= 0.6) {
        await learnerAgent.applyEvent(userId, { category }, 'organic', 0, confidence);
      }
      eventBus.emitEvent('transaction.matched', { transaction: updated });
      return updated;
    }

    return txn;
  }

  /**
   * Habit Miner: Detect recurring leisure habits (3 occurrences in 6 weeks)
   */
  async mineHabits(userId: string): Promise<Habit[]> {
    const txns = await transactionsRepo.getByUserId(userId);
    const now = Date.now();
    const sixWeeksMs = 42 * 86400000;

    // Filter leisure transactions within 6 weeks
    const recentLeisure = txns.filter((t) => {
      const time = new Date(t.occurred_at).getTime();
      return !t.excluded && t.kind !== 'essential' && now - time <= sixWeeksMs;
    });

    // Group by day_of_week + time_bucket + category
    const habitBuckets = new Map<
      string,
      {
        dayOfWeek: number;
        timeBucket: 'morning' | 'afternoon' | 'evening' | 'night';
        category: string;
        amounts: number[];
        weeks: Set<number>;
      }
    >();

    for (const t of recentLeisure) {
      const d = new Date(t.occurred_at);
      const dayOfWeek = d.getUTCDay();
      const hour = d.getUTCHours();

      let timeBucket: 'morning' | 'afternoon' | 'evening' | 'night' = 'evening';
      if (hour >= 6 && hour < 12) timeBucket = 'morning';
      else if (hour >= 12 && hour < 17) timeBucket = 'afternoon';
      else if (hour >= 17 && hour < 22) timeBucket = 'evening';
      else timeBucket = 'night';

      const cat = t.category ?? 'cafes';
      const bucketKey = `${dayOfWeek}:${timeBucket}:${cat}`;

      const weekNum = Math.floor(d.getTime() / (7 * 86400000));

      if (!habitBuckets.has(bucketKey)) {
        habitBuckets.set(bucketKey, {
          dayOfWeek,
          timeBucket,
          category: cat,
          amounts: [t.amount_minor],
          weeks: new Set([weekNum])
        });
      } else {
        const b = habitBuckets.get(bucketKey)!;
        b.amounts.push(t.amount_minor);
        b.weeks.add(weekNum);
      }
    }

    const detectedHabits: Habit[] = [];

    for (const b of habitBuckets.values()) {
      // At least 3 distinct weeks
      if (b.weeks.size >= 3) {
        b.amounts.sort((x, y) => x - y);
        const median = b.amounts[Math.floor(b.amounts.length / 2)] ?? 2000;

        const habit: Habit = {
          id: crypto.randomUUID(),
          user_id: userId,
          day_of_week: b.dayOfWeek,
          time_bucket: b.timeBucket,
          category: b.category,
          typical_amount_minor: median,
          occurrences: b.amounts.length,
          window_weeks: 6,
          status: 'active',
          last_seen_at: new Date().toISOString()
        };

        await occasionsRepo.upsertHabit(habit);
        detectedHabits.push(habit);
        eventBus.emitEvent('habit.detected', {
          habitId: habit.id,
          userId,
          category: habit.category
        });
      }
    }

    await auditRepo.log({
      user_id: userId,
      agent: this.name,
      action: 'habits_mined',
      result: { detectedCount: detectedHabits.length }
    });

    return detectedHabits;
  }
}

export const trackerAgent = new TrackerAgent();
