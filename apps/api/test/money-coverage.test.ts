import { describe, it, expect } from 'vitest';
import { moneyService, normalizeToMonthlyMinor } from '../src/services/money.js';
import { ValidationError } from '../src/core/errors.js';

describe('money: parsing, validation and conversion', () => {
  describe('toMinorUnits', () => {
    it('parses exact decimal strings and numbers without float error', () => {
      expect(moneyService.toMinorUnits('10.50')).toBe(1050);
      expect(moneyService.toMinorUnits('0.07')).toBe(7);
      expect(moneyService.toMinorUnits('1,234.56')).toBe(123456);
      expect(moneyService.toMinorUnits(19.99)).toBe(1999);
      expect(moneyService.toMinorUnits('-5.25')).toBe(-525);
      expect(moneyService.toMinorUnits('500', 'JPY')).toBe(500); // zero-decimal currency
    });

    it('tolerates trailing zeros beyond the exponent but REJECTS lost precision (never silently truncates)', () => {
      expect(moneyService.toMinorUnits('10.500')).toBe(1050);
      expect(() => moneyService.toMinorUnits('10.505')).toThrow(ValidationError);
      expect(() => moneyService.toMinorUnits('10.5', 'JPY')).toThrow(ValidationError);
    });

    it.each([['abc'], [''], ['1.2.3'], ['--5'], ['5-'], ['$5'], ['1e3'], ['.5'], [' ']])('rejects the malformed amount %j', (bad) => {
      expect(() => moneyService.toMinorUnits(bad as string)).toThrow(ValidationError);
    });

    it('rejects non-finite numbers, exponent notation, non-numbers and unsupported currencies', () => {
      expect(() => moneyService.toMinorUnits(Infinity)).toThrow(/Invalid amount/);
      expect(() => moneyService.toMinorUnits(NaN)).toThrow(/Invalid amount/);
      expect(() => moneyService.toMinorUnits(1e21)).toThrow(/exponent notation/);
      expect(() => moneyService.toMinorUnits({} as never)).toThrow(/Invalid amount/);
      expect(() => moneyService.toMinorUnits('5', 'XYZ')).toThrow(/Unsupported currency/);
    });

    it('rejects amounts beyond the safe integer range instead of rounding them', () => {
      expect(() => moneyService.toMinorUnits('99999999999999999999')).toThrow(/out of range/);
    });
  });

  describe('toPayPalValue', () => {
    it('renders exact decimal strings per currency exponent', () => {
      expect(moneyService.toPayPalValue(1050, 'USD')).toBe('10.50');
      expect(moneyService.toPayPalValue(7, 'USD')).toBe('0.07');
      expect(moneyService.toPayPalValue(500, 'JPY')).toBe('500');
    });
    it('refuses an unsupported currency', () => {
      expect(() => moneyService.toPayPalValue(100, 'XYZ')).toThrow(ValidationError);
    });
  });

  describe('convertMinorPreservingMajor', () => {
    it('keeps the same major amount across different exponents', () => {
      expect(moneyService.convertMinorPreservingMajor(1000, 'USD', 'JPY')).toBe(10); // $10.00 -> 10 yen
      expect(moneyService.convertMinorPreservingMajor(1000, 'JPY', 'USD')).toBe(100000); // 1000 yen -> 1000.00
      expect(moneyService.convertMinorPreservingMajor(1234, 'USD', 'USD')).toBe(1234);
    });
    it('throws on an unsupported currency on either side', () => {
      expect(() => moneyService.convertMinorPreservingMajor(100, 'XYZ', 'USD')).toThrow(/Unsupported currency/);
      expect(() => moneyService.convertMinorPreservingMajor(100, 'USD', 'XYZ')).toThrow(/Unsupported currency/);
    });
  });

  describe('format', () => {
    it('formats with the right symbol and fraction digits', () => {
      expect(moneyService.format(123456, 'USD')).toBe('$1,234.56');
      expect(moneyService.format(500, 'JPY')).toBe('¥500');
      expect(moneyService.format(-1234, 'USD')).toBe('-$12.34');
    });
    it('falls back to a plain dollar format for an unknown/invalid currency code instead of throwing', () => {
      expect(moneyService.format(1234, 'NOPE-CODE')).toBe('$12.34');
      expect(moneyService.format(-1234, 'NOPE-CODE')).toBe('-$12.34');
    });
  });

  describe('validateCustomSplit', () => {
    it('requires shares to sum to exactly the total', () => {
      expect(moneyService.validateCustomSplit([3000, 3000, 4000], 10000)).toBe(true);
      expect(moneyService.validateCustomSplit([3000, 3000, 3999], 10000)).toBe(false);
      expect(moneyService.validateCustomSplit([], 0)).toBe(true);
      expect(moneyService.validateCustomSplit([], 1)).toBe(false);
    });
  });

  describe('normalizeToMonthlyMinor', () => {
    it('converts each interval to monthly using exact integer rounding', () => {
      expect(normalizeToMonthlyMinor(1000, 'monthly')).toBe(1000);
      expect(normalizeToMonthlyMinor(1000, 'weekly')).toBe(4333); // 1000*52/12
      expect(normalizeToMonthlyMinor(12000, 'yearly')).toBe(1000);
      expect(normalizeToMonthlyMinor(12000, 'annually')).toBe(1000);
      expect(normalizeToMonthlyMinor(100, 'daily')).toBe(3042); // 100*365/12
      expect(moneyService.normalizeToMonthlyMinor(12000, 'yearly')).toBe(1000);
    });
    it('leaves an unrecognised interval unchanged rather than guessing', () => {
      expect(normalizeToMonthlyMinor(777, 'fortnightly')).toBe(777);
    });
  });
});
