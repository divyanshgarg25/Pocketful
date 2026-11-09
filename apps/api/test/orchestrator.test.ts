import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { orchestratorAgent } from '../src/agents/orchestrator.js';
import { trackerAgent } from '../src/agents/tracker.js';
import { plannerAgent } from '../src/agents/planner.js';
import { venuesRepo } from '../src/repos/venues.js';
import { transactionsRepo } from '../src/repos/transactions.js';
import { groupsRepo } from '../src/repos/groups.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { vaultRepo } from '../src/repos/vault.js';
import type { Suggestion, Transaction } from '../src/schemas/domain.js';

describe('Phase 6: Orchestrator Intent Honesty, Tier-1 Tracking & Opt-Ins (H5, H8)', () => {
  let server: Server;
  let baseUrl: string;
  let authHeader: { Authorization: string; 'Content-Type': string };
  const userId = '00000000-0000-4000-a000-000000000001';

  beforeAll(async () => {
    initLocalSeed();
    const token = await createDevToken(userId, 'aarav@pocketful.demo', 'Aarav Sharma');
    authHeader = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

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

  beforeEach(() => {
    initLocalSeed();
  });

  describe('Intent Routing & Splitting Honesty', () => {
    it('does NOT create fabricated $75 split groups when user asks about bill splitting in chat', async () => {
      const initialGroups = await groupsRepo.getGroupsByOrganizer(userId);
      const initialCount = initialGroups.length;

      const response = await orchestratorAgent.processUserMessage(
        userId,
        'How does bill splitting work with friends?'
      );

      expect(response.reply).toContain('Split tab');
      expect(response.reply).toContain('PayPal');
      expect(response.pendingApprovals).toHaveLength(0);

      // Verify NO phantom group was created
      const currentGroups = await groupsRepo.getGroupsByOrganizer(userId);
      expect(currentGroups.length).toBe(initialCount);
    });

    it('uses word-boundary matching to prevent false-positive trigger on substring words', async () => {
      // "explanation" should not trigger the plan generator
      const res = await orchestratorAgent.processUserMessage(
        userId,
        'Give me an explanation of your features'
      );
      // General greeting / overview fallback rather than plan tickets
      expect(res.cards?.some((c) => c['type'] === 'plan_tickets')).toBeFalsy();
    });

    it('routes explicit plan keywords to ticket generation', async () => {
      const res = await orchestratorAgent.processUserMessage(
        userId,
        'Can you make a plan for my weekend?'
      );
      expect(res.cards?.some((c) => c['type'] === 'plan_tickets')).toBe(true);
    });
  });

  describe('Proactive Chat Endpoint Zod Validation (POST /api/chat/proactive)', () => {
    it('accepts valid friday_brief type', async () => {
      const res = await fetch(`${baseUrl}/api/chat/proactive`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ type: 'friday_brief' })
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.data.note.content).toContain('Friday afternoon');
    });

    it('accepts valid sunday_vault type', async () => {
      const res = await fetch(`${baseUrl}/api/chat/proactive`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ type: 'sunday_vault' })
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.data.note.content).toContain('Sunday evening');
    });

    it('rejects invalid or unexpected proactive note type with 400', async () => {
      const res = await fetch(`${baseUrl}/api/chat/proactive`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ type: 'invalid_malicious_type' })
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Tier-1 Tracker Matching with Accepted Suggestions & Tolerance', () => {
    it('successfully links transaction to accepted suggestion within 48h and 25% tolerance', async () => {
      const venue = (await venuesRepo.getAll())[0]!;

      // 1. Create an accepted suggestion decided 2 hours ago
      const suggestionId = '55555555-6666-7777-8888-999999999999';
      const suggestion: Suggestion = {
        id: suggestionId,
        user_id: userId,
        plan_id: '11111111-2222-3333-4444-555555555555',
        venue_id: venue.id,
        slot: 'comfort',
        features: {},
        outcome: 'accepted',
        shown_at: new Date(Date.now() - 2 * 3600000).toISOString(),
        decided_at: new Date(Date.now() - 2 * 3600000).toISOString()
      };
      localDb.suggestions.set(suggestionId, suggestion);

      // 2. Ingest transaction at venue within estimate bounds
      const txn: Transaction = {
        id: 'txn-tier1-test-001',
        user_id: userId,
        source: 'paypal_sandbox',
        source_ref: 'PAYPAL-TXN-101',
        occurred_at: new Date().toISOString(),
        amount_minor: venue.est_cost_low_minor ?? 2000,
        currency: 'USD',
        merchant_raw: venue.name,
        merchant_norm: venue.name.toLowerCase(),
        needs_question: false,
        excluded: false
      };
      await transactionsRepo.insert(txn);

      const matched = await trackerAgent.matchTransaction(txn, userId);

      expect(matched.match_type).toBe('followed');
      expect(matched.linked_suggestion_id).toBe(suggestionId);
      expect(matched.venue_id).toBe(venue.id);
      expect(matched.confidence).toBe(0.9);
    });

    it('does not link as followed if transaction is outside 25% cost tolerance', async () => {
      const venue = (await venuesRepo.getAll())[0]!;

      const suggestionId = '66666666-7777-8888-9999-000000000000';
      const suggestion: Suggestion = {
        id: suggestionId,
        user_id: userId,
        plan_id: '11111111-2222-3333-4444-555555555555',
        venue_id: venue.id,
        slot: 'comfort',
        features: {},
        outcome: 'accepted',
        shown_at: new Date(Date.now() - 2 * 3600000).toISOString(),
        decided_at: new Date(Date.now() - 2 * 3600000).toISOString()
      };
      localDb.suggestions.set(suggestionId, suggestion);

      // Ingest an amount 10x higher than venue high estimate
      const exorbitantAmount = (venue.est_cost_high_minor ?? 3000) * 10;
      const txn: Transaction = {
        id: 'txn-tier1-test-002',
        user_id: userId,
        source: 'paypal_sandbox',
        source_ref: 'PAYPAL-TXN-102',
        occurred_at: new Date().toISOString(),
        amount_minor: exorbitantAmount,
        currency: 'USD',
        merchant_raw: venue.name,
        merchant_norm: venue.name.toLowerCase(),
        needs_question: false,
        excluded: false
      };
      await transactionsRepo.insert(txn);

      const matched = await trackerAgent.matchTransaction(txn, userId);
      // Not matched as Tier-1 followed because cost is vastly out of bounds
      expect(matched.linked_suggestion_id).toBeNull();
      expect(matched.match_type).not.toBe('followed');
    });
  });

  describe('Privacy & User Opt-In Enforcement', () => {
    it('planner defaults to neutral mood and does not query checkin if opt_in_mood is false', async () => {
      const profile = await profilesRepo.getById(userId);
      expect(profile).toBeTruthy();
      await profilesRepo.upsert({ ...profile!, opt_in_mood: false });

      // Save a "drained" mood checkin
      await vaultRepo.saveMoodCheckin(userId, 'drained');

      // Generate plan without passing explicit mood
      const plan = await plannerAgent.generatePlan(userId);

      // Should be neutral 'okay' because opt_in_mood is false
      expect(plan.mood).toBe('okay');
    });

    it('tracker sync skips automated tracking when opt_in_tracking is false', async () => {
      const profile = await profilesRepo.getById(userId);
      await profilesRepo.upsert({ ...profile!, opt_in_tracking: false });

      const res = await fetch(`${baseUrl}/api/tracker/sync`, {
        method: 'POST',
        headers: authHeader
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.optedOut).toBe(true);
      expect(data.data.syncedCount).toBe(0);
    });
  });
});