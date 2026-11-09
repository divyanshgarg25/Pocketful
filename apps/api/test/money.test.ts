import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { moneyService, CURRENCY_EXPONENTS, MAX_MINOR } from '../src/services/money.js';
import { auditorAgent } from '../src/agents/auditor.js';
import { subscriptionsRepo } from '../src/repos/subscriptions.js';
import { transactionsRepo } from '../src/repos/transactions.js';
import type { Transaction, Subscription } from '../src/schemas/domain.js';

describe('Phase 7: Exact Minor Arithmetic, Currency Exponents & Data Honesty (H7, M-money)', () => {
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

  describe('Exact String Parsing to Minor Units (Zero Float Arithmetic)', () => {
    it('converts standard 2-decimal currencies without floating point artifacts', () => {
      expect(moneyService.toMinorUnits('19.99', 'USD')).toBe(1999);
      expect(moneyService.toMinorUnits('0.01', 'USD')).toBe(1);
      expect(moneyService.toMinorUnits('123.45', 'USD')).toBe(12345);
      expect(moneyService.toMinorUnits('1,234.56', 'USD')).toBe(123456);
      expect(moneyService.toMinorUnits('100', 'USD')).toBe(10000);
      expect(moneyService.toMinorUnits('-45.50', 'USD')).toBe(-4550);
    });

    it('honors 0-decimal currencies (JPY, KRW) without adding fake cents', () => {
      expect(moneyService.toMinorUnits('2500', 'JPY')).toBe(2500);
      expect(moneyService.toMinorUnits('10000', 'KRW')).toBe(10000);
    });

    it('honors 3-decimal currencies (KWD)', () => {
      expect(moneyService.toMinorUnits('12.345', 'KWD')).toBe(12345);
      expect(moneyService.toMinorUnits('5.5', 'KWD')).toBe(5500);
    });
  });

  describe('Intl Currency Formatting & Exponent Table', () => {
    it('formats 2-decimal, 0-decimal, and 3-decimal currencies correctly', () => {
      const formattedUsd = moneyService.format(2500, 'USD');
      expect(formattedUsd).toContain('25.00');

      const formattedJpy = moneyService.format(2500, 'JPY');
      expect(formattedJpy).toContain('2,500');
      expect(formattedJpy).not.toContain('.00');

      const formattedKwd = moneyService.format(2500, 'KWD');
      expect(formattedKwd).toContain('2.500');
    });

    it('formats PayPal values with exact fixed decimal places according to exponent', () => {
      expect(moneyService.toPayPalValue(2500, 'USD')).toBe('25.00');
      expect(moneyService.toPayPalValue(2500, 'JPY')).toBe('2500');
      expect(moneyService.toPayPalValue(2500, 'KWD')).toBe('2.500');
    });

    it('defines explicit maximum minor unit upper bound (MAX_MINOR)', () => {
      expect(MAX_MINOR).toBe(10_000_000_00);
      expect(CURRENCY_EXPONENTS['USD']).toBe(2);
      expect(CURRENCY_EXPONENTS['JPY']).toBe(0);
      expect(CURRENCY_EXPONENTS['KWD']).toBe(3);
    });
  });

  describe('Normalized Subscription Rational Arithmetic (52 / 12)', () => {
    it('normalizes weekly subscription using rational (52 / 12) without float multiplier error', async () => {
      // Clear existing subscriptions and add a single weekly ghost subscription of $10.00
      localDb.subscriptions.clear();

      const weeklyGhost: Subscription = {
        id: 'sub-weekly-ghost-1',
        user_id: userId,
        merchant: 'Weekly Newsletter Pro',
        amount_minor: 1000, // $10.00 per week
        interval: 'weekly',
        paypal_subscription_id: 'I-SUB-WEEKLY-1',
        status: 'active',
        flagged_ghost: true,
        ghost_reason: 'Unused weekly subscription'
      };
      await subscriptionsRepo.getByUserId(userId);
      localDb.subscriptions.set(weeklyGhost.id, weeklyGhost);

      const audit = await auditorAgent.runAudit(userId);

      // (1000 * 52) / 12 = 52000 / 12 = 4333.333 -> 4333
      expect(audit.totalMonthlyWasteMinor).toBe(4333);
      // Yearly waste: 4333 * 12 = 51996
      expect(audit.totalYearlyWasteMinor).toBe(51996);
    });
  });

  describe('Itemized Till Receipt Honors Specific Week ISO Window', () => {
    it('returns only transactions occurring within the requested week parameter', async () => {
      localDb.transactions.clear();

      // Txn 1: in week 2026-10-12 to 2026-10-18
      const txn1: Transaction = {
        id: 'txn-oct-12',
        user_id: userId,
        source: 'paypal_sandbox',
        source_ref: 'REF-1',
        occurred_at: '2026-10-14T12:00:00.000Z',
        amount_minor: 3500,
        currency: 'USD',
        merchant_raw: 'October Cafe',
        merchant_norm: 'october cafe',
        kind: 'leisure',
        category: 'cafes',
        needs_question: false,
        excluded: false
      };

      // Txn 2: in another week (2026-11-02)
      const txn2: Transaction = {
        id: 'txn-nov-02',
        user_id: userId,
        source: 'paypal_sandbox',
        source_ref: 'REF-2',
        occurred_at: '2026-11-04T12:00:00.000Z',
        amount_minor: 5000,
        currency: 'USD',
        merchant_raw: 'November Bistro',
        merchant_norm: 'november bistro',
        kind: 'leisure',
        category: 'food',
        needs_question: false,
        excluded: false
      };

      await transactionsRepo.insert(txn1);
      await transactionsRepo.insert(txn2);

      // Query receipt for the October week
      const res = await fetch(`${baseUrl}/api/receipt/2026-10-12`, {
        headers: authHeader
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.data.receipt.items).toHaveLength(1);
      expect(data.data.receipt.items[0].name).toBe('October Cafe');
      expect(data.data.receipt.totalSpentMinor).toBe(3500);
    });
  });
});