import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initLocalSeed, localDb, handleSingleResult } from '../src/core/database.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { plansRepo } from '../src/repos/plans.js';
import { suggestionsRepo } from '../src/repos/suggestions.js';
import { transactionsRepo } from '../src/repos/transactions.js';
import { subscriptionsRepo } from '../src/repos/subscriptions.js';
import { groupsRepo } from '../src/repos/groups.js';
import { vaultRepo } from '../src/repos/vault.js';
import type { Plan, Suggestion, Transaction, Group } from '../src/schemas/domain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 5: Database, RLS & Migration Hardening (H1, H3)', () => {
  const userAaravId = '00000000-0000-4000-a000-000000000001';
  const userPriyaId = '00000000-0000-4000-a000-000000000002';

  beforeEach(() => {
    initLocalSeed();
  });

  describe('Database Error Handling & PGRST116 Discrimination', () => {
    it('returns data when error is null', () => {
      const data = { id: '123', name: 'Test' };
      const res = handleSingleResult(data, null, 'TestRepo');
      expect(res).toBe(data);
    });

    it('returns null safely when error code is PGRST116 (0 rows found)', () => {
      const res = handleSingleResult(null, { code: 'PGRST116', message: 'No rows found' }, 'TestRepo');
      expect(res).toBeNull();
    });

    it('throws closed error when database fails with a real error (connection, syntax, or RLS)', () => {
      expect(() => {
        handleSingleResult(null, { code: '42501', message: 'permission denied for table profiles' }, 'TestRepo');
      }).toThrow(/permission denied/);

      expect(() => {
        handleSingleResult(null, { code: '57P01', message: 'admin shutdown' }, 'TestRepo');
      }).toThrow(/admin shutdown/);
    });
  });

  describe('Multi-Tenant Data Isolation by userId in Repos', () => {
    it('plansRepo enforces userId ownership on getById', async () => {
      const planId = '11111111-2222-3333-4444-555555555555';
      const plan: Plan = {
        id: planId,
        user_id: userAaravId,
        status: 'open',
        created_at: new Date().toISOString()
      };
      await plansRepo.create(plan);

      // Accessing with correct userId succeeds
      const ownPlan = await plansRepo.getById(planId, userAaravId);
      expect(ownPlan?.id).toBe(planId);

      // Accessing with another userId fails closed and returns null
      const foreignPlan = await plansRepo.getById(planId, userPriyaId);
      expect(foreignPlan).toBeNull();
    });

    it('suggestionsRepo enforces userId ownership on getById', async () => {
      const sId = '22222222-3333-4444-5555-666666666666';
      const suggestion: Suggestion = {
        id: sId,
        user_id: userAaravId,
        plan_id: '11111111-2222-3333-4444-555555555555',
        venue_id: '00000000-0000-4000-b000-000000000001',
        slot: 'comfort',
        features: {}
      };
      localDb.suggestions.set(sId, suggestion);

      const own = await suggestionsRepo.getById(sId, userAaravId);
      expect(own?.id).toBe(sId);

      const foreign = await suggestionsRepo.getById(sId, userPriyaId);
      expect(foreign).toBeNull();
    });

    it('transactionsRepo enforces userId ownership on getById, updateRating, and setExcluded', async () => {
      const txnId = '33333333-4444-5555-6666-777777777777';
      const txn: Transaction = {
        id: txnId,
        user_id: userAaravId,
        source: 'paypal_sandbox',
        source_ref: 'REF-TXN-1',
        occurred_at: new Date().toISOString(),
        amount_minor: 4500,
        currency: 'USD',
        merchant_raw: 'Coffee Shop',
        merchant_norm: 'Coffee Shop',
        needs_question: false,
        excluded: false
      };
      await transactionsRepo.insert(txn);

      // getById
      expect(await transactionsRepo.getById(txnId, userAaravId)).toBeTruthy();
      expect(await transactionsRepo.getById(txnId, userPriyaId)).toBeNull();

      // updateRating with mismatched user does not update
      const badRatingUpdate = await transactionsRepo.updateRating(txnId, 'worth_it', userPriyaId);
      expect(badRatingUpdate).toBeNull();
      const fresh1 = await transactionsRepo.getById(txnId);
      expect(fresh1?.user_rating).toBeUndefined();

      // setExcluded with mismatched user does not update
      const badExcludeUpdate = await transactionsRepo.setExcluded(txnId, true, userPriyaId);
      expect(badExcludeUpdate).toBeNull();
      const fresh2 = await transactionsRepo.getById(txnId);
      expect(fresh2?.excluded).toBe(false);
    });

    it('subscriptionsRepo enforces userId ownership on getById', async () => {
      const sub = await subscriptionsRepo.getByUserId(userAaravId);
      expect(sub.length).toBeGreaterThan(0);
      const subId = sub[0]!.id;

      expect(await subscriptionsRepo.getById(subId, userAaravId)).toBeTruthy();
      expect(await subscriptionsRepo.getById(subId, userPriyaId)).toBeNull();
    });

    it('groupsRepo enforces organizerId ownership on getGroupById', async () => {
      const gId = '44444444-5555-6666-7777-888888888888';
      const group: Group = {
        id: gId,
        organizer_id: userAaravId,
        suggestion_id: null,
        transaction_id: null,
        total_minor: 5000,
        currency: 'USD',
        deadline: new Date(Date.now() + 86400000).toISOString(),
        status: 'draft',
        created_at: new Date().toISOString()
      };
      await groupsRepo.createGroup(group);

      expect(await groupsRepo.getGroupById(gId, userAaravId)).toBeTruthy();
      expect(await groupsRepo.getGroupById(gId, userPriyaId)).toBeNull();
    });
  });

  describe('Privacy & Data Erasure (eraseUser)', () => {
    it('completely erases all associated data for a user across all collections', async () => {
      // Confirm user has seeded records
      expect(await profilesRepo.getById(userAaravId)).toBeTruthy();
      expect(await profilesRepo.getPreferences(userAaravId)).toBeTruthy();
      expect(await vaultRepo.getVault(userAaravId)).toBeTruthy();
      expect((await subscriptionsRepo.getByUserId(userAaravId)).length).toBeGreaterThan(0);

      // Erase user
      const erased = await profilesRepo.eraseUser(userAaravId);
      expect(erased).toBe(true);

      // Verify records are gone
      expect(await profilesRepo.getById(userAaravId)).toBeNull();
      expect(await profilesRepo.getPreferences(userAaravId)).toBeNull();
      expect(await vaultRepo.getVault(userAaravId)).toBeNull();
      expect((await subscriptionsRepo.getByUserId(userAaravId)).length).toBe(0);
      expect((await transactionsRepo.getByUserId(userAaravId)).length).toBe(0);
      expect(await plansRepo.getLatestForUser(userAaravId)).toBeNull();
      expect((await vaultRepo.getPockets(userAaravId)).length).toBe(0);
    });
  });

  describe('Migration 004 Security & Integrity Invariants File Audit', () => {
    it('verifies 004_security_hardening.sql contains all mandated security clauses', () => {
      const migrationPath = path.resolve(__dirname, '../../../supabase/migrations/004_security_hardening.sql');
      expect(fs.existsSync(migrationPath)).toBe(true);

      const content = fs.readFileSync(migrationPath, 'utf8');

      // 1. Weekly Money Out View Isolation
      expect(content).toContain('security_invoker = true');
      expect(content).toContain("date_trunc('week', now() at time zone 'UTC')");
      expect(content).toContain('revoke all on weekly_money_out from public;');

      // 2. Internal Tables Lockdown
      expect(content).toContain('alter table if exists webhook_events enable row level security;');
      expect(content).toContain('alter table if exists llm_cache enable row level security;');
      expect(content).toContain('alter table if exists job_runs enable row level security;');
      expect(content).toContain('revoke all on webhook_events from public, anon;');

      // 3. Statement-level TRUNCATE trigger
      expect(content).toContain('forbid_truncate()');
      expect(content).toContain('before truncate on audit_log');
      expect(content).toContain('before truncate on approvals');

      // 4. Approval Transition-Guard Trigger
      expect(content).toContain('guard_approval_transition()');
      expect(content).toContain('before update on approvals');

      // 5. Approval Events Audit Table
      expect(content).toContain('create table if not exists approval_events');
      expect(content).toContain('record_approval_transition_event()');

      // 6. Non-negative & uniqueness constraints
      expect(content).toContain('uq_group_payments_group_contact');
      expect(content).toContain('chk_profiles_currency');
      expect(content).toContain('chk_vault_non_negative');

      // 7. GDPR Erase Stored Procedure
      expect(content).toContain('create or replace function erase_user');
      expect(content).toContain('security definer');
    });
  });
});