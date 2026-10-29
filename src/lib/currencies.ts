// The currencies a user can choose for an instrument. The live list comes from
// SovfHub (its system_currencies table), so adding one there adds it here. If
// SovfHub can't be reached, a built-in list of common currencies is used so that
// issuing never stops just because of this.

import { listCurrencies, type SovfhubCurrency } from './sovfhub';

export type Currency = SovfhubCurrency;

const FALLBACK: Currency[] = [
  { code: 'GBP', name: 'United Kingdom Pound', symbol: '£', symbolAfter: false, default: true },
  { code: 'USD', name: 'United States Dollar', symbol: '$', symbolAfter: false, default: false },
  { code: 'EUR', name: 'Euro', symbol: '€', symbolAfter: false, default: false },
  { code: 'AUD', name: 'Australia Dollar', symbol: '$', symbolAfter: false, default: false },
  { code: 'CAD', name: 'Canada Dollar', symbol: '$', symbolAfter: false, default: false },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: '$', symbolAfter: false, default: false },
  { code: 'CHF', name: 'Switzerland Franc', symbol: 'CHF', symbolAfter: false, default: false },
  { code: 'JPY', name: 'Japan Yen', symbol: '¥', symbolAfter: false, default: false },
  { code: 'INR', name: 'India Rupee', symbol: '₹', symbolAfter: true, default: false },
  { code: 'SGD', name: 'Singapore Dollar', symbol: '$', symbolAfter: false, default: false },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: '$', symbolAfter: false, default: false },
  { code: 'ZAR', name: 'South Africa Rand', symbol: 'R', symbolAfter: false, default: false },
];

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; list: Currency[]; live: boolean } | null = null;

// A currency we can put on an instrument: a 3-letter code and a short, plain symbol.
const usable = (c: Currency) =>
  /^[A-Z]{3}$/.test(c.code) && c.symbol.length > 0 && c.symbol.length <= 8 && !/[<>&"]/.test(c.symbol);

export async function getCurrencies(): Promise<{ list: Currency[]; live: boolean }> {
  if (cache && Date.now() - cache.at < TTL_MS) return { list: cache.list, live: cache.live };
  try {
    const { currencies } = await listCurrencies();
    const list = currencies.filter(usable);
    if (list.length === 0) throw new Error('empty currency list');
    cache = { at: Date.now(), list, live: true };
  } catch {
    // keep serving the last good live list if we have one, else the built-in list
    cache = cache?.live ? { ...cache, at: Date.now() } : { at: Date.now() - TTL_MS + 30_000, list: FALLBACK, live: false };
  }
  return { list: cache.list, live: cache.live };
}

export const findCurrency = (list: Currency[], code: string) => list.find((c) => c.code === code.trim().toUpperCase());
