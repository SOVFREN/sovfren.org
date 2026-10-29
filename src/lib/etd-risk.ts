// Controls that limit losses. Three simple rules, applied when an instrument is issued:
//
//  1. A limit per person, per currency: how much one issuing party may owe at any
//     one time. Someone with no limit set gets the default (ETD_DEFAULT_LIMIT, 1,000.00
//     in each currency), so new people start small. A limit of 0 blocks a person.
//  2. A visible record: what each person owes, and how they have paid so far.
//  3. An automatic stop: while any of their instruments is past its maturity date and
//     still unpaid, that person cannot issue anything new.
//
// The "issuing party" is the maker of a promissory note, or the drawer of a bill of
// exchange, identified by Companion No. / ref if given, otherwise by name.
// Limits are stored in ETD_DIR/limits.json.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { etdEnv, root } from './etd-paths';
import { formatCents, parseCents, splitPayable } from './maturity';
import type { Instrument, Party, State, Terms } from './etd';

export interface Row {
  inst: Instrument;
  state: State;
}

export class RiskError extends Error {}

// ---------- who is the issuing party ----------

export const issuerParty = (t: Terms): Party | undefined => (t.type === 'promissory_note' ? t.maker : t.drawer);
const clean = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
export const issuerKey = (p?: Pick<Party, 'name' | 'ref'>) => (p ? clean(p.ref?.trim() || p.name) : '');
export const issuerLabel = (p?: Party) => (p ? p.name + (p.ref ? ` (${p.ref})` : '') : '');

// ---------- limits ----------

interface LimitValue {
  amount: string;
  by: string;
  at: string;
}
export type LimitFile = Record<string, { name: string; limits: Record<string, LimitValue> }>;

const file = () => path.join(root(), 'limits.json');

export function defaultLimit(): string {
  const v = etdEnv('ETD_DEFAULT_LIMIT') ?? '1000.00';
  return parseCents(v) !== null ? formatCents(parseCents(v)!) : '1000.00';
}

export async function getLimits(): Promise<LimitFile> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as LimitFile;
  } catch {
    return {};
  }
}

let chain: Promise<unknown> = Promise.resolve();
export function setLimit(issuerText: string, name: string, currency: string, amount: string, by: string): Promise<void> {
  const key = clean(issuerText);
  const code = currency.trim().toUpperCase();
  if (!key) return Promise.reject(new Error('Enter who the limit is for.'));
  if (!/^[A-Z]{3}$/.test(code)) return Promise.reject(new Error('Currency must be a 3-letter code.'));
  const cents = parseCents(amount);
  if (cents === null) return Promise.reject(new Error('Enter the limit as an amount, for example 5000.00. Use 0 to block.'));
  const next = chain
    .catch(() => {})
    .then(async () => {
      const all = await getLimits();
      const entry = all[key] ?? { name: name.trim() || issuerText.trim(), limits: {} };
      entry.limits[code] = { amount: formatCents(cents), by, at: new Date().toISOString() };
      all[key] = entry;
      await mkdir(path.dirname(file()), { recursive: true });
      const tmp = `${file()}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2));
      await rename(tmp, file());
    });
  chain = next;
  return next;
}

export function limitFor(limits: LimitFile, key: string, currency: string): { amount: string; explicit: boolean } {
  const set = limits[key]?.limits[currency];
  return set ? { amount: set.amount, explicit: true } : { amount: defaultLimit(), explicit: false };
}

// ---------- exposure and lateness ----------

const faceOf = (t: Terms) => t.maturityValue ?? t.amount; // what is actually owed at the end, interest included
const today = () => new Date().toISOString().slice(0, 10);

// Still owed: active instruments only. Paid and cancelled ones free up the limit.
export function owed(rows: Row[], key: string, currency: string): bigint {
  return rows
    .filter((r) => r.state.status === 'active' && issuerKey(issuerParty(r.inst.terms)) === key && r.inst.terms.currency === currency)
    .reduce((sum, r) => sum + (parseCents(faceOf(r.inst.terms)) ?? 0n), 0n);
}

// Past its maturity date and still unpaid. (Whole days, UTC: it is overdue the day after.)
export function isOverdue(r: Row, now = today()): boolean {
  if (r.state.status !== 'active') return false;
  const due = splitPayable(r.inst.terms.payableOn);
  return !due.onDemand && !!due.date && due.date < now;
}

export function overdueFor(rows: Row[], key: string, now = today()): Row[] {
  return rows.filter((r) => issuerKey(issuerParty(r.inst.terms)) === key && isOverdue(r, now));
}

// ---------- the gate ----------

export function check(rows: Row[], limits: LimitFile, terms: Terms, now = today()): void {
  const key = issuerKey(issuerParty(terms));
  if (!key) return;
  const who = issuerLabel(issuerParty(terms));

  const late = overdueFor(rows, key, now);
  if (late.length) {
    throw new RiskError(
      `${who} has an instrument that is past its maturity date and unpaid (${late.map((r) => r.inst.terms.serial).join(', ')}). ` +
        'Nothing new can be issued for them until it is paid or cancelled.',
    );
  }

  const limit = limitFor(limits, key, terms.currency);
  const limitCents = parseCents(limit.amount)!;
  const wanted = parseCents(faceOf(terms)) ?? 0n;
  const already = owed(rows, key, terms.currency);
  if (limitCents === 0n) throw new RiskError(`${who} is not currently allowed to issue in ${terms.currency}.`);
  if (already + wanted > limitCents) {
    throw new RiskError(
      `${who} can owe up to ${terms.currency} ${formatCents(limitCents)}${limit.explicit ? '' : ' (the standard starting limit)'}. ` +
        `They owe ${formatCents(already)} now, so another ${formatCents(wanted)} would be over the limit. ` +
        'Raise their limit on the Issuers page if that is intended.',
    );
  }
}

// ---------- the record ----------

export interface IssuerRecord {
  key: string;
  name: string;
  perCurrency: { currency: string; owed: string; limit: string; explicit: boolean }[];
  issued: number;
  active: number;
  paidOnTime: number;
  paidLate: number;
  cancelled: number;
  overdue: { serial: string; id: string }[];
}

export function records(rows: Row[], limits: LimitFile, now = today()): IssuerRecord[] {
  const keys = new Map<string, string>(); // key -> display name
  for (const [k, v] of Object.entries(limits)) keys.set(k, v.name);
  for (const r of rows) {
    const p = issuerParty(r.inst.terms);
    const k = issuerKey(p);
    if (k && !keys.has(k)) keys.set(k, issuerLabel(p));
  }
  const out: IssuerRecord[] = [];
  for (const [key, name] of keys) {
    const mine = rows.filter((r) => issuerKey(issuerParty(r.inst.terms)) === key);
    const currencies = new Set<string>([...mine.map((r) => r.inst.terms.currency), ...Object.keys(limits[key]?.limits ?? {})]);
    const rec: IssuerRecord = {
      key,
      name,
      perCurrency: [...currencies].sort().map((currency) => ({
        currency,
        owed: formatCents(owed(rows, key, currency)),
        ...(() => {
          const l = limitFor(limits, key, currency);
          return { limit: l.amount, explicit: l.explicit };
        })(),
      })),
      issued: mine.length,
      active: mine.filter((r) => r.state.status === 'active').length,
      paidOnTime: 0,
      paidLate: 0,
      cancelled: mine.filter((r) => r.state.status === 'cancelled').length,
      overdue: overdueFor(rows, key, now).map((r) => ({ serial: r.inst.terms.serial, id: r.inst.id })),
    };
    for (const r of mine.filter((m) => m.state.status === 'paid')) {
      const due = splitPayable(r.inst.terms.payableOn);
      const paidOn = r.inst.events.find((e) => e.type === 'pay')?.at.slice(0, 10) ?? '';
      if (due.onDemand || !due.date || paidOn <= due.date) rec.paidOnTime += 1;
      else rec.paidLate += 1;
    }
    out.push(rec);
  }
  return out.sort((a, b) => b.overdue.length - a.overdue.length || a.name.localeCompare(b.name));
}

/** Applied inside issue(): refuses to create an instrument that breaks a rule. */
export async function assertCanIssue(rows: Row[], terms: Terms): Promise<void> {
  check(rows, await getLimits(), terms);
}
