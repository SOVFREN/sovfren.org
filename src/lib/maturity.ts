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
