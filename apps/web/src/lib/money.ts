/**
 * Pocketful Web Client Money Formatting & Arithmetic
 * Standard Integer Minor Units & Largest-Remainder Algorithm Parity
 */

export const CURRENCY_EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  INR: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3
};

export function formatMoney(amountMinor: number, currency = 'USD'): string {
  const upper = (currency || 'USD').toUpperCase();
  const exp = CURRENCY_EXPONENTS[upper] ?? 2;
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

export function toMinorUnits(amount: string | number, currency = 'USD'): number {
  const exp = CURRENCY_EXPONENTS[currency.toUpperCase()] ?? 2;
  if (typeof amount === 'number') {
    amount = amount.toString();
  }
  const clean = amount.trim().replace(/,/g, '');
  const isNegative = clean.startsWith('-');
  const val = isNegative ? clean.slice(1) : clean;
  const parts = val.split('.');
  const integerPart = parts[0] || '0';
  let fractionPart = parts[1] || '';

  if (exp === 0) {
    const res = parseInt(integerPart, 10);
    return isNegative ? -res : res;
  }

  if (fractionPart.length > exp) {
    fractionPart = fractionPart.slice(0, exp);
  } else {
    fractionPart = fractionPart.padEnd(exp, '0');
  }

  const minorStr = `${integerPart}${fractionPart}`;
  const result = parseInt(minorStr, 10);
  return isNegative ? -result : result;
}
