// Maturity and interest for notes and bills. Pure functions shared by the server
// (sealed into the signed terms at issue) and the browser (live preview).
//
// Simple interest on whole days:
//   interest = principal x rate% x days / day-count basis, rounded half up to the cent.
// All money is handled as integer cents (BigInt), never floats.

export type DayCount = 'ACT/365' | 'ACT/360';
export const DAY_COUNTS: Record<DayCount, number> = { 'ACT/365': 365, 'ACT/360': 360 };
export const isDayCount = (v: string): v is DayCount => v === 'ACT/365' || v === 'ACT/360';

/** "12500.00" -> 1250000n; null if not a valid figure (1-15 digits, up to 2 decimals). */
export function parseCents(amount: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

export function formatCents(c: bigint): string {
  const whole = c / 100n;
  const cents = c % 100n;
  return `${whole}.${cents.toString().padStart(2, '0')}`;
}

/** "4.5" -> 45000n (percent, 4 decimal places). Null unless 0 < rate <= 100. */
export function parseRate(rate: string): bigint | null {
  const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(rate.trim());
  if (!m) return null;
  const scaled = BigInt(m[1]) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0') || '0');
  return scaled > 0n && scaled <= 1_000_000n ? scaled : null;
}

/** 45000n -> "4.5" */
export function formatRate(scaled: bigint): string {
  const whole = scaled / 10000n;
  const frac = (scaled % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Whole calendar days from one YYYY-MM-DD date to another (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function interestCents(principal: bigint, rateScaled: bigint, days: number, dayCount: DayCount): bigint {
  if (days <= 0) return 0n;
  const num = principal * rateScaled * BigInt(days);
  const den = 1_000_000n * BigInt(DAY_COUNTS[dayCount]);
  return (num * 2n + den) / (den * 2n); // half up
}

export interface Maturity {
  principal: string;
  interest: string;
  total: string;
  days: number;
}

/** Principal, interest and total for the period from `from` to `to` (YYYY-MM-DD). */
export function maturityValue(amount: string, rate: string, dayCount: DayCount, from: string, to: string): Maturity | null {
  const principal = parseCents(amount);
  const r = parseRate(rate);
  if (principal === null || r === null) return null;
  const days = Math.max(0, daysBetween(from, to));
  const interest = interestCents(principal, r, days, dayCount);
  return { principal: formatCents(principal), interest: formatCents(interest), total: formatCents(principal + interest), days };
}

/** Interest that builds up each day, for an instrument with no fixed maturity. */
export function perDiem(amount: string, rate: string, dayCount: DayCount): string | null {
  const principal = parseCents(amount);
  const r = parseRate(rate);
  if (principal === null || r === null) return null;
  return formatCents(interestCents(principal, r, 1, dayCount)); // one day's interest, rounded to the cent
}

export interface Payable {
  onDemand: boolean;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM, in the instrument's time zone
}

/** Reads the stored `payableOn`: "on demand", "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM". */
export function splitPayable(payableOn: string): Payable {
  if (payableOn.trim().toLowerCase() === 'on demand') return { onDemand: true };
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/.exec(payableOn.trim());
  return m ? { onDemand: false, date: m[1], time: m[2] } : { onDemand: false };
}

// ---------- discounting: what a buyer would pay before maturity ----------
// A holder who wants cash early can sell at a price below the amount due at maturity.
// Money-market yield convention: price = face / (1 + yield x days / basis), whole days,
// rounded to the cent. Indicative arithmetic only; nothing here is recorded on the instrument.

const roundDiv = (n: bigint, d: bigint) => (2n * n + d) / (2n * d); // half up, for n >= 0

export interface Discount {
  days: number;
  face: string; // paid at maturity
  price: string; // paid now
  discount: string; // face - price
  returnPct: string; // buyer's return over the period on the price paid, %
  yieldPct: string; // annualised, money-market basis, %
  discountRatePct: string; // annualised, quoted on face value (bank-discount basis), %
}

function describe(face: bigint, price: bigint, days: number, dayCount: DayCount, yieldScaled: bigint): Discount {
  const basis = BigInt(DAY_COUNTS[dayCount]);
  const diff = face - price;
  const n = BigInt(days);
  return {
    days,
    face: formatCents(face),
    price: formatCents(price),
    discount: formatCents(diff),
    returnPct: formatRate(price > 0n ? roundDiv(diff * 1_000_000n, price) : 0n),
    yieldPct: formatRate(yieldScaled),
    discountRatePct: formatRate(n > 0n && face > 0n ? roundDiv(diff * basis * 1_000_000n, face * n) : 0n),
  };
}

/** Price a buyer would pay for `face` due in `days`, to earn `yieldPct` a year. */
export function priceFromYield(face: string, yieldPct: string, days: number, dayCount: DayCount): Discount | null {
  const f = parseCents(face);
  const y = parseRate(yieldPct);
  if (f === null || y === null || !Number.isInteger(days) || days < 0) return null;
  const a = 1_000_000n * BigInt(DAY_COUNTS[dayCount]);
  const b = y * BigInt(days);
  return describe(f, roundDiv(f * a, a + b), days, dayCount, y);
}

/** The annual yield a buyer earns by paying `price` for `face` due in `days`. */
export function yieldFromPrice(face: string, price: string, days: number, dayCount: DayCount): Discount | null {
  const f = parseCents(face);
  const p = parseCents(price);
  if (f === null || p === null || p <= 0n || p > f || !Number.isInteger(days) || days <= 0) return null;
  const y = roundDiv((f - p) * BigInt(DAY_COUNTS[dayCount]) * 1_000_000n, p * BigInt(days));
  return describe(f, p, days, dayCount, y);
}

// ---------- exchanging into another currency ----------
// Two parties agree a rate; these helpers only do the arithmetic, exactly, in whole cents.

/** "0.95" -> 950000n (6 decimal places). Null unless the rate is above 0. */
export function parseFxRate(rate: string): bigint | null {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(rate.trim());
  if (!m) return null;
  const scaled = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  return scaled > 0n ? scaled : null;
}

/** 950000n -> "0.95" */
export function formatFxRate(scaled: bigint): string {
  const whole = scaled / 1_000_000n;
  const frac = (scaled % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Cents in one currency -> cents in another at the agreed rate, rounded half up. */
export function convertCents(cents: bigint, rateScaled: bigint): bigint {
  return (cents * rateScaled * 2n + 1_000_000n) / 2_000_000n;
}

/** What an instrument is worth on `today`: principal plus any interest built up so far. */
export function valueToday(amount: string, rate: string | undefined, dayCount: DayCount, issuedAt: string, today: string): string | null {
  if (!rate) return parseCents(amount) === null ? null : formatCents(parseCents(amount)!);
  return maturityValue(amount, rate, dayCount, issuedAt, today)?.total ?? null;
}
