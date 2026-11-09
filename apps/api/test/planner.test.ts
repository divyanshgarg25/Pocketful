import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { plannerAgent } from '../src/agents/planner.js';
import { CostEstimatesSchema } from '../src/services/gemini.js';
import { placesService } from '../src/services/places.js';
import { venuesRepo } from '../src/repos/venues.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { localDb } from '../src/core/database.js';
import { transactionsRepo } from '../src/repos/transactions.js';
import { banditRepo } from '../src/repos/bandit.js';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';

describe('Planner Agent, Gemini, and Places Hardening (H12)', () => {
  let server: Server;
  let baseUrl: string;
  const userId = '00000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(async () => {
    localDb.plans.clear();
    localDb.suggestions.clear();
    localDb.place_queries.clear();
    localDb.bandit_state.clear();
    localDb.learning_events = [];

    // Ensure user profile exists
    if (!(await profilesRepo.getById(userId))) {
      await profilesRepo.upsert({
        id: userId,
        email: 'test@pocketful.app',
        display_name: 'Test Explorer',
        home_address: '123 Market St',
        home_lat: 37.7749,
        home_lng: -122.4194,
        guilt_free_cap_minor: 25000,
        currency: 'USD',
        max_distance_km: 15,
        opt_in_mood: true,
        opt_in_tracking: true
      });
    }
  });

  it('CostEstimatesSchema rejects invalid costs where low > high or negative', () => {
    const invalidLowGreater = {
      estimates: [
        {
          venue_id: 'v1',
          low: 3000,
          high: 1500, // Invalid: low > high
          basis: 'test',
          confidence: 'high'
        }
      ]
    };

    expect(() => CostEstimatesSchema.parse(invalidLowGreater)).toThrow();

    const invalidNegative = {
      estimates: [
        {
          venue_id: 'v1',
          low: -500, // Invalid: negative
          high: 1500,
          basis: 'test',
          confidence: 'high'
        }
      ]
    };

    expect(() => CostEstimatesSchema.parse(invalidNegative)).toThrow();

    const valid = {
      estimates: [
        {
          venue_id: 'v1',
          low: 1000,
          high: 2500,
          basis: 'test',
          confidence: 'high'
        }
      ]
    };

    expect(() => CostEstimatesSchema.parse(valid)).not.toThrow();
  });

  it('returns only the surviving distinct slots (fewer than 3) without duplicating when fewer than 3 venues survive', async () => {
    // Spy on findNearbyVenues to simulate quiet location with only 1 venue
    const singleVenue = (await venuesRepo.getAll())[0]!;
    const placesSpy = vi.spyOn(placesService, 'findNearbyVenues').mockResolvedValue([singleVenue]);

    const result = await plannerAgent.generatePlan(userId, { radiusKm: 5 });

    expect(result).toBeDefined();
    expect(result.slots.length).toBe(1);
    expect(result.slots[0]!.venue.id).toBe(singleVenue.id);
    expect(result.slots[0]!.slot).toBe('comfort');

    // Test with 2 venues: should return exactly 2 distinct slots without duplicates
    const all = await venuesRepo.getAll();
    const twoVenues = [all[0]!, all[1]!];
    placesSpy.mockResolvedValue(twoVenues);

    const result2 = await plannerAgent.generatePlan(userId, { radiusKm: 5 });
    expect(result2.slots.length).toBe(2);
    const venueIds = new Set(result2.slots.map((s) => s.venue.id));
    expect(venueIds.size).toBe(2);

    placesSpy.mockRestore();
  });

  it('venuesRepo place query expires after 7-day TTL', async () => {
    const queryKey = 'test_query_ttl_key';
    const venueIds = ['v1', 'v2'];

    // Save place query
    await venuesRepo.savePlaceQuery(queryKey, venueIds);

    // Fresh query should return venueIds
    const freshResult = await venuesRepo.getPlaceQuery(queryKey);
    expect(freshResult).toEqual(venueIds);

    // Simulated expired query: set fetched_at to 8 days ago
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    localDb.place_queries.set(queryKey, { venue_ids: venueIds, fetched_at: eightDaysAgo });

    // Expired query should return null (triggering re-query)
    const expiredResult = await venuesRepo.getPlaceQuery(queryKey);
    expect(expiredResult).toBeNull();
  });

  it('POST /api/tracker/:id/rating rolls back previous rating before applying new rating', async () => {
    const token = await createDevToken(userId, 'test@pocketful.app');

    // Create a transaction
    const txn = {
      id: '00000000-0000-4000-8000-000000000099',
      user_id: userId,
      source: 'manual' as const,
      source_ref: 'ref_rating_test',
      occurred_at: new Date().toISOString(),
      amount_minor: 4000,
      currency: 'USD',
      merchant_raw: 'Artisan Cafe',
      merchant_norm: 'artisan cafe',
      kind: 'leisure' as const,
      category: 'cafes',
      venue_id: null,
      linked_suggestion_id: null,
      match_type: 'organic' as const,
      confidence: 1.0,
      needs_question: false,
      user_rating: null,
      excluded: false
    };
    await transactionsRepo.insert(txn);

    // 1. Initial rating: 'worth_it'
    const res1 = await fetch(`${baseUrl}/api/tracker/${txn.id}/rating`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ rating: 'worth_it' })
    });

    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { data: { ratingRecorded: string } };
    expect(json1.data.ratingRecorded).toBe('worth_it');

    let state = (await banditRepo.getBanditStateForUser(userId)).get('category:cafes')!;
    const alphaAfterWorthIt = state.alpha;
    expect(alphaAfterWorthIt).toBe(2.5); // baseline 1 + 1.5

    // 2. Change rating: 'too_much'
    const res2 = await fetch(`${baseUrl}/api/tracker/${txn.id}/rating`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ rating: 'too_much' })
    });

    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as { data: { ratingRecorded: string } };
    expect(json2.data.ratingRecorded).toBe('too_much');

    // Previous alpha should have been reverted!
    state = (await banditRepo.getBanditStateForUser(userId)).get('category:cafes')!;
    expect(state.alpha).toBeLessThan(alphaAfterWorthIt);

    // Price band high beta should now be penalized
    const priceState = (await banditRepo.getBanditStateForUser(userId)).get('price_band:mid')!;
    expect(priceState.beta).toBe(2); // 1 + 1.0
  });
});
