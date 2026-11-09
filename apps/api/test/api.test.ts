import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { moneyService } from '../src/services/money.js';
import { placesService } from '../src/services/places.js';
import { guardianAgent } from '../src/agents/guardian.js';
import { learnerAgent } from '../src/agents/learner.js';
import { auditorAgent } from '../src/agents/auditor.js';
import { plannerAgent } from '../src/agents/planner.js';
import { splitterAgent } from '../src/agents/splitter.js';
import { trackerAgent } from '../src/agents/tracker.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import type { Profile } from '../src/schemas/domain.js';

describe('Pocketful Backend & Agent Core Test Suite', () => {
  const testUserId = '00000000-0000-4000-a000-000000000001';
  const originalFetch = global.fetch;

  beforeAll(() => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (urlStr.includes('nominatim.openstreetmap.org/search')) {
        return new Response(
          JSON.stringify([
            { lat: '37.7749', lon: '-122.4194', display_name: 'Mission District, San Francisco, CA' }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('nominatim.openstreetmap.org/reverse')) {
        return new Response(
          JSON.stringify({
            display_name: 'San Francisco, California',
            address: { neighbourhood: 'Mission District', city: 'San Francisco', state: 'California' }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('overpass')) {
        return new Response(
          JSON.stringify({ elements: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    initLocalSeed();
  });

  describe('Step 2.1: Money & Ledger Math Service', () => {
    it('computes discretionary fun money capped by guilt_free_cap', () => {
      // balance: $2840, bills: $1450, subs: $100, goal: $400 -> remaining: $890. Cap is $150.
      const fun = moneyService.computeFunMoney(284000, 145000, 10000, 40000, 15000);
      expect(fun).toBe(15000); // capped at $150.00
    });

    it('splits total cost equally without penny loss using largest-remainder method', () => {
      // Split $100.00 (10000 cents) among 3 friends
      const shares = moneyService.splitEqual(10000, 3);
      expect(shares).toEqual([3334, 3333, 3333]);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(10000); // Penny-perfect match

      // Split $10.00 (1000 cents) among 3 friends
      const sharesTen = moneyService.splitEqual(1000, 3);
      expect(sharesTen).toEqual([334, 333, 333]);
      expect(sharesTen.reduce((a, b) => a + b, 0)).toBe(1000);

      // Split ₹100 (10000 paise) among 3 friends
      const sharesRupee = moneyService.splitEqual(10000, 3);
      expect(sharesRupee).toEqual([3334, 3333, 3333]);
      expect(sharesRupee.reduce((a, b) => a + b, 0)).toBe(10000);

      // Split $1.00 (100 cents) among 7 friends
      const sharesSeven = moneyService.splitEqual(100, 7);
      expect(sharesSeven).toEqual([15, 15, 14, 14, 14, 14, 14]);
      expect(sharesSeven.reduce((a, b) => a + b, 0)).toBe(100);
    });

    it('formats currency correctly for USD and INR', () => {
      expect(moneyService.format(2550, 'USD')).toBe('$25.50');
      expect(moneyService.format(50000, 'INR')).toBe('₹500.00');
      expect(moneyService.format(-1200, 'USD')).toBe('-$12.00');
    });
  });

  describe('Step 2.2: Places & Geolocation Service', () => {
    it('calculates accurate Haversine distance between coordinates', () => {
      // SF City Hall to Mission District ~2.1 km
      const dist = placesService.haversineKm(37.7792, -122.4191, 37.7600, -122.4194);
      expect(dist).toBeGreaterThan(1.5);
      expect(dist).toBeLessThan(3.0);
    });

    it('calculates road distance with 1.35x factor', () => {
      const road = placesService.roadDistanceKm(37.7792, -122.4191, 37.7600, -122.4194);
      const direct = placesService.haversineKm(37.7792, -122.4191, 37.7600, -122.4194);
      expect(road).toBeCloseTo(direct * 1.35, 1);
    });

    it('reverse geocodes coordinates to human-readable area', async () => {
      const res = await placesService.reverseGeocode(37.7749, -122.4194);
      expect(res.lat).toBe(37.7749);
      expect(res.lng).toBe(-122.4194);
      expect(res.displayName).toContain('San Francisco');
    });

    it('geocodes address queries to coordinate pairs', async () => {
      const res = await placesService.geocodeAddress('Mission District, San Francisco');
      expect(res.lat).toBeCloseTo(37.77, 1);
      expect(res.lng).toBeCloseTo(-122.42, 1);
    });
  });

  describe('Step 3.1: The Guardian Agent (Deterministic Safety)', () => {
    const user: Profile = {
      id: testUserId,
      name: 'Aarav Sharma',
      timezone: 'America/Los_Angeles',
      home_lat: 37.7749,
      home_lng: -122.4194,
      home_label: 'SF',
      max_distance_km: 8.0,
      guilt_free_cap_minor: 15000,
      per_action_cap_minor: 25000, // $250 cap
      weekly_cap_minor: 50000,     // $500 cap
      currency: 'USD',
      opt_in_mood: true,
      opt_in_tracking: true,
      exploration_level: 'normal'
    };

    it('blocks actions exceeding per-action cap', async () => {
      const evalResult = await guardianAgent.evaluate(user, {
        type: 'send_requests',
        amountMinor: 30000, // $300 exceeds $250
        payload: {},
        preview: 'Split $300'
      });
      expect(evalResult.kind).toBe('block');
      if (evalResult.kind === 'block') {
        expect(evalResult.reason).toContain('exceeds your per-action safety cap');
      }
    });

    it('requires approval for money actions within caps', async () => {
      const evalResult = await guardianAgent.evaluate(user, {
        type: 'cancel_subscription',
        amountMinor: 4900,
        payload: { subscriptionId: 'sub_1' },
        preview: 'Cancel Gym'
      });
      expect(evalResult.kind).toBe('needs_approval');
    });

    it('creates an approval with 10-minute expiry', async () => {
      const { approval } = await guardianAgent.requestApproval(user, {
        type: 'cancel_subscription',
        amountMinor: 4900,
        payload: { sub: 'gym' },
        preview: 'Cancel CloudGym'
      });
      expect(approval).not.toBeNull();
      expect(approval?.status).toBe('pending');
      const now = Date.now();
      const expiry = new Date(approval!.expires_at).getTime();
      expect(expiry - now).toBeGreaterThan(9 * 60 * 1000);
      expect(expiry - now).toBeLessThanOrEqual(10 * 60 * 1000);
    });
  });

  describe('Step 3.2: The Learner Agent (Thompson Sampling)', () => {
    it('scores candidates using Thompson Sampling over Beta distributions', () => {
      const stateMap = new Map();
      stateMap.set('category:cafes', { user_id: testUserId, feature: 'category', value: 'cafes', alpha: 5, beta: 1 });
      const score = learnerAgent.score({ category: 'cafes' }, stateMap);
      expect(score).toBeGreaterThan(0);
    });

    it('penalizes only the named feature upon rejection', async () => {
      const features = { category: 'cafes', distance_band: '5-10km', price_band: 'high' };
      await learnerAgent.applyRejection(testUserId, features, 'too_far');
      const state = localDb.bandit_state.get(`${testUserId}:distance_band:5-10km`);
      expect(state).toBeDefined();
      expect(state!.beta).toBeGreaterThan(1); // Beta increased
      // Category should remain unpenalized
      const catState = localDb.bandit_state.get(`${testUserId}:category:cafes`);
      expect(catState?.beta).toBe(1);
    });
  });

  describe('Step 3.3: The Auditor Agent', () => {
    it('identifies seeded ghost subscriptions and calculates yearly waste', async () => {
      const audit = await auditorAgent.runAudit(testUserId);
      expect(audit.ghostSubscriptions.length).toBe(3);
      // $49 + $14.99 + $12 = $75.99/mo -> $911.88/yr
      expect(audit.totalYearlyWasteMinor).toBe(91188);
      expect(audit.totalYearlyWasteFormatted).toBe('$911.88');
    });
  });

  describe('Step 3.4: The Planner Agent (Closed-World Recommendation)', () => {
    it('generates 3-slot plan satisfying budget and distance', async () => {
      const plan = await plannerAgent.generatePlan(testUserId, { mood: 'drained' });
      expect(plan.slots.length).toBe(3);
      const slotTypes = plan.slots.map((s) => s.slot);
      expect(slotTypes).toContain('comfort');
      expect(slotTypes).toContain('stretch');
      expect(slotTypes).toContain('new');

      for (const slot of plan.slots) {
        expect(slot.distKm).toBeLessThanOrEqual(plan.radiusKm);
        expect(slot.costHighMinor).toBeLessThanOrEqual(plan.budgetMinor);
      }
    });
  });

  describe('Step 3.5: The Splitter Agent', () => {
    it('creates group with penny-perfect friend shares and stages approval', async () => {
      const result = await splitterAgent.createGroupSplit(testUserId, {
        friends: [
          { name: 'Amit', contact: 'amit@example.com' },
          { name: 'Neha', contact: 'neha@example.com' }
        ],
        totalMinor: 9000, // $90.00
        splitMode: 'equal'
      });

      expect(result.payments.length).toBe(2);
      expect(result.payments[0]!.share_minor).toBe(3000); // 90 / 3 = 30
      expect(result.approval).not.toBeNull();
      expect(result.approval?.action_type).toBe('send_requests');
    });
  });

  describe('Step 3.6: The Tracker Agent', () => {
    it('identifies essential transactions and classifies leisure', () => {
      expect(trackerAgent.isEssential('Safeway Grocery Store #482')).toBe(true);
      expect(trackerAgent.isEssential('Landlord Rent Transfer')).toBe(true);
      expect(trackerAgent.isEssential('Quiet Leaf Cafe Roastery')).toBe(false);
    });

    it('mines habits from recurring leisure visits', async () => {
      const habits = await trackerAgent.mineHabits(testUserId);
      expect(habits).toBeDefined();
    });
  });
});
