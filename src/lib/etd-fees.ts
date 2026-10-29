// Administration fee for issuing an Electronic Trade Document, paid from the
// issuer's SovfHub Treasury Wallet.
//
// Issuing never takes the fee without delivering the instrument, and never
// delivers one without the fee:
//   1. hold     the fee is taken from the wallet (SovfHub; repeat-safe by reference)
//   2. issue    the instrument is created and signed
//   3. capture  the fee is marked earned   (or refund, if step 2 failed)
// If SovfHub can't be reached for step 3 or the refund, the unfinished fee is
// written to ETD_DIR/fees.jsonl and shown to admins to settle, so nothing is lost.

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { etdFeeCapture, etdFeeHold, etdFeeQuote, etdFeeRefund, type EtdFeeQuote } from './sovfhub';
import { root } from './etd';

type FeeState = 'held' | 'captured' | 'refunded' | 'capture_pending' | 'refund_pending';

interface FeeLogEntry {
  at: string;
  reference: string;
  state: FeeState;
  amount: string;
  by: string; // Companion Number
  instrument?: string;
}

const logFile = () => path.join(root(), 'fees.jsonl');

async function log(entry: Omit<FeeLogEntry, 'at'>): Promise<void> {
  await mkdir(root(), { recursive: true });
  await appendFile(logFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

async function readLog(): Promise<FeeLogEntry[]> {
  try {
    return (await readFile(logFile(), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FeeLogEntry);
  } catch {
    return [];
  }
}

// Fees that were taken but not yet settled either way. Latest entry per reference wins.
export async function unsettledFees(): Promise<FeeLogEntry[]> {
  const latest = new Map<string, FeeLogEntry>();
  for (const e of await readLog()) latest.set(e.reference, e);
  return [...latest.values()].filter((e) => !['captured', 'refunded'].includes(e.state));
}

export async function getFeeQuote(accessToken: string): Promise<EtdFeeQuote | null> {
  try {
    return await etdFeeQuote(accessToken);
  } catch {
    return null;
  }
}

// Settles a stuck fee with the same user's token: captures it if an instrument
// was issued, otherwise gives it back.
export async function settleFee(accessToken: string, entry: FeeLogEntry): Promise<void> {
  if (entry.instrument) {
    await etdFeeCapture(accessToken, entry.reference, entry.instrument);
    await log({ reference: entry.reference, state: 'captured', amount: entry.amount, by: entry.by, instrument: entry.instrument });
  } else {
    await etdFeeRefund(accessToken, entry.reference);
    await log({ reference: entry.reference, state: 'refunded', amount: entry.amount, by: entry.by });
  }
}

export async function issueWithFee<T extends { id: string }>(
  accessToken: string,
  by: string,
  issueFn: () => Promise<T>,
): Promise<{ instrument: T; feePaid: string | null; warning?: string }> {
  const quote = await etdFeeQuote(accessToken); // throws if SovfHub is unreachable: don't issue unpriced
  if (!quote.charging) return { instrument: await issueFn(), feePaid: null };

  const reference = randomBytes(16).toString('hex');
  // Logged first, so a real hold can never go unrecorded.
  await log({ reference, state: 'held', amount: quote.amount, by });
  try {
    await etdFeeHold(accessToken, reference); // throws, with a clear message, if the balance is too low
  } catch (e) {
    await log({ reference, state: 'refunded', amount: quote.amount, by }); // nothing was taken: close the entry
    throw e;
  }

  let instrument: T;
  try {
    instrument = await issueFn();
  } catch (e) {
    try {
      await etdFeeRefund(accessToken, reference);
      await log({ reference, state: 'refunded', amount: quote.amount, by });
    } catch {
      await log({ reference, state: 'refund_pending', amount: quote.amount, by });
    }
    throw e;
  }

  try {
    await etdFeeCapture(accessToken, reference, instrument.id);
    await log({ reference, state: 'captured', amount: quote.amount, by, instrument: instrument.id });
    return { instrument, feePaid: quote.amount };
  } catch {
    await log({ reference, state: 'capture_pending', amount: quote.amount, by, instrument: instrument.id });
    return {
      instrument,
      feePaid: quote.amount,
      warning: 'The instrument was issued and the fee was taken, but SovfHub could not confirm it yet. It will show under "Fees to settle".',
    };
  }
}
