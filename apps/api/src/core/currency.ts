/** Single source of truth for supported currencies. Must match chk_profiles_currency / chk_groups_currency in SQL. */
import { z } from 'zod';

export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY', 'KRW', 'KWD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
export const CurrencySchema = z.enum(SUPPORTED_CURRENCIES);

/** ISO-4217 minor-unit exponents for the supported currencies. */
export const CURRENCY_EXPONENTS: Record<SupportedCurrency, number> = {
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, INR: 2, JPY: 0, KRW: 0, KWD: 3
};

export function isSupportedCurrency(c: unknown): c is SupportedCurrency {
  return typeof c === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(c);
}
