/**
 * Pocketful Money and Ledger Math Service
 * Strict Integer Minor-Units Arithmetic (no floating point currency calculation)
 * Largest-Remainder Method for penny-perfect group cost splitting.
 */

import { ValidationError } from '../core/errors.js';
import { CURRENCY_EXPONENTS, isSupportedCurrency } from '../core/currency.js';

export { CURRENCY_EXPONENTS };

export const MAX_MINOR = 10_000_000_00; // $10,000,000.00 minor unit cap

export class MoneyService {
  /**
   * Compute available discretionary "fun money"
   * Formula: balance - fixed bills - subscriptions - savings goal, capped by guilt_free_cap
   */
  computeFunMoney(
    balanceMinor: number,
    fixedBillsMinor: number,
    subscriptionsMinor: number,
    savingsGoalMinor: number,
    guiltFreeCapMinor: number
  ): number {
    const rawFree = balanceMinor - fixedBillsMinor - subscriptionsMinor - savingsGoalMinor;
    const available = Math.max(0, rawFree);
    // Cap semantics (SECURITY.md): a guilt-free cap of 0 means NOTHING is available, never "uncapped".
    return Math.min(available, Math.max(0, guiltFreeCapMinor));
  }

  /**
   * Split total cost equally among N participants using the Largest-Remainder method.
   * Guarantees that the sum of parts is EXACTLY equal to totalMinor down to the last cent.
   * Supports deterministic penny rotation so the extra cents are fairly distributed.
   */
  splitEqual(totalMinor: number, count: number, rotationOffset = 0): number[] {
    if (!Number.isInteger(totalMinor) || totalMinor <= 0) {
      throw new ValidationError(`Total split amount must be a positive integer, received: ${totalMinor}`);
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new ValidationError(`Participant count must be a positive integer, received: ${count}`);
    }

    const baseShare = Math.floor(totalMinor / count);
    const remainder = totalMinor % count;

    const result: number[] = Array(count).fill(baseShare);
    const startIdx = ((rotationOffset % count) + count) % count;

    for (let r = 0; r < remainder; r++) {
      const idx = (startIdx + r) % count;
      result[idx] = (result[idx] ?? baseShare) + 1;
    }
    return result;
  }

  /**
   * Verify that custom shares sum to the exact total
   */
  validateCustomSplit(shares: number[], totalMinor: number): boolean {
    const sum = shares.reduce((acc, curr) => acc + curr, 0);
    return sum === totalMinor;
  }

  /**
   * Format minor units into human-readable currency with correct symbol and fraction digits
   * Uses standard Intl.NumberFormat
   */
  format(amountMinor: number, currency = 'USD'): string {
    const upper = currency.toUpperCase();
    const exp = isSupportedCurrency(upper) ? CURRENCY_EXPONENTS[upper] : 2;
    const major = amountMinor / Math.pow(10, exp);

    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: upper,
        minimumFractionDigits: exp,
        maximumFractionDigits: exp
      }).format(major);
    } catch {
      const isNegative = amountMinor < 0;
      return `${isNegative ? '-' : ''}$${Math.abs(major).toFixed(exp)}`;
    }
  }

  /**
   * Re-express a minor-unit amount in another currency's minor units WITHOUT any FX rate:
   * the major-unit number is preserved (e.g. 25000 USD-minor = 250.00 -> 250 JPY = 250 minor).
   * Used for caps, which are plain numbers the user chose; only the exponent changes.
   */
  convertMinorPreservingMajor(amountMinor: number, fromCurrency: string, toCurrency: string): number {
    const fromUpper = fromCurrency.toUpperCase();
    const toUpper = toCurrency.toUpperCase();
    if (!isSupportedCurrency(fromUpper) || !isSupportedCurrency(toUpper)) throw new Error('Unsupported currency');
    const from = CURRENCY_EXPONENTS[fromUpper];
    const to = CURRENCY_EXPONENTS[toUpper];
    return Math.round((amountMinor * 10 ** to) / 10 ** from);
  }

  /**
   * Convert minor units to major float string for PayPal API payloads
   */
  toPayPalValue(amountMinor: number, currency = 'USD'): string {
    const code = currency.toUpperCase();
    if (!isSupportedCurrency(code)) throw new ValidationError(`Unsupported currency: ${currency}`);
    const exp = CURRENCY_EXPONENTS[code];
    const divisor = Math.pow(10, exp);
    const major = amountMinor / divisor;
    return exp === 0 ? Math.round(major).toString() : major.toFixed(exp);
  }

  /**
   * Convert major float or decimal string to integer minor units via exact integer math
   * Avoids floating point binary representation anomalies (e.g. 19.99 * 100 != 1999)
   */
  toMinorUnits(amount: string | number, currency = 'USD'): number {
    const code = String(currency).toUpperCase();
    if (!isSupportedCurrency(code)) throw new ValidationError(`Unsupported currency: ${currency}`);
    const exp = CURRENCY_EXPONENTS[code];
    if (typeof amount === 'number') {
      if (!Number.isFinite(amount)) throw new ValidationError(`Invalid amount: ${amount}`);
      amount = amount.toString();
      if (/e/i.test(amount)) throw new ValidationError(`Invalid amount (exponent notation): ${amount}`);
    }
    if (typeof amount !== 'string') throw new ValidationError('Invalid amount.');
    const clean = amount.trim().replace(/,/g, '');
    const m = /^(-)?(\d+)(?:\.(\d*))?$/.exec(clean);
    if (!m) throw new ValidationError(`Invalid amount: "${amount}"`);
    const isNegative = Boolean(m[1]);
    const integerPart = m[2] as string;
    const fractionPart = m[3] ?? '';
    // More fractional digits than the currency allows is an error, never silent truncation.
    // (Trailing zeros beyond the exponent, e.g. "10.500" for USD, are tolerated: no value is lost.)
    if (fractionPart.length > exp && /[1-9]/.test(fractionPart.slice(exp))) {
      throw new ValidationError(`Amount "${amount}" has more than ${exp} fractional digit(s) for ${code}.`);
    }
    const frac = fractionPart.slice(0, exp).padEnd(exp, '0');
    const result = Number(`${integerPart}${frac}`);
    if (!Number.isSafeInteger(result)) throw new ValidationError(`Amount out of range: "${amount}"`);
    return isNegative ? -result : result;
  }

  /**
   * Normalize any recurring interval minor amount to monthly minor units using exact integer rounding
   */
  normalizeToMonthlyMinor(amountMinor: number, interval: string): number {
    return normalizeToMonthlyMinor(amountMinor, interval);
  }
}

export function normalizeToMonthlyMinor(amountMinor: number, interval: string): number {
  switch (interval.toLowerCase()) {
    case 'monthly':
      return amountMinor;
    case 'weekly':
      return Math.round((amountMinor * 52) / 12);
    case 'yearly':
    case 'annually':
      return Math.round(amountMinor / 12);
    case 'daily':
      return Math.round((amountMinor * 365) / 12);
    default:
      return amountMinor;
  }
}

export const moneyService = new MoneyService();
