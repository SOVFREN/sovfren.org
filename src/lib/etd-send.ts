// Sending an instrument to someone outside the network, by email.
//
// Flow: the holder signs an OFFER (naming the recipient and the fingerprint of a one-time code); the registry
// emails the recipient a link carrying the code; the recipient opens it, creates their own key and ACCEPTS, which
// is the delivery. Until then the instrument is locked; the holder can withdraw; it lapses after the expiry.
// Everything is a signed event in the instrument's chain. The recipient's email address is kept only in the
// registry's private outbox (data directory) and is deleted when the offer ends; the chain keeps a masked form.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { act, getInstrument, replay, root, type Instrument } from './etd';
import { mailConfigured, offerEmail, sendMail } from './mail';

const outDir = () => path.join(root(), 'outbox');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

const DAILY_LIMIT = 20; // offers one person can send in 24 hours, to keep this from being used for spam

export function maskEmail(email: string): string {
  const [local, domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

interface OutboxEntry {
  instrument: string;
  email: string;
  by: string;
  createdAt: string;
}

async function sentToday(by: string): Promise<number> {
  try {
    const since = Date.now() - 864e5;
    let n = 0;
    for (const f of await readdir(outDir())) {
      if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
      const e = JSON.parse(await readFile(path.join(outDir(), f), 'utf8')) as OutboxEntry;
      if (e.by === by && Date.parse(e.createdAt) >= since) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Deletes the stored email address once the offer has ended (claimed or withdrawn). */
export async function closeOffer(tokenHash: string): Promise<void> {
  if (HEX64.test(tokenHash)) await rm(path.join(outDir(), `${tokenHash}.json`), { force: true });
}

export interface OfferInput {
  email: string;
  toName: string;
  toRef?: string;
  token: string; // one-time code, made in the holder's browser
  tokenHash: string; // sha256 of the code, which is what the holder signed
  expiresAt: string;
  holderSig: string;
}

export interface OfferResult {
  inst: Instrument;
  link: string;
  emailed: boolean;
  reason?: string;
  mask: string;
}

export async function sendOffer(id: string, expectSeq: number, input: OfferInput, by: string, baseUrl: string): Promise<OfferResult> {
  const email = input.email.trim();
  if (!/^[^\s@<>"]{1,64}@[^\s@<>"]{1,200}\.[A-Za-z]{2,}$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
  if (!HEX64.test(input.token) || !HEX64.test(input.tokenHash) || sha256(input.token) !== input.tokenHash) {
    throw new Error('The one-time code was not made properly. Reload the page and try again.');
  }
  if ((await sentToday(by)) >= DAILY_LIMIT) throw new Error('You have reached the limit of offers for today. Try again tomorrow.');

  const before = await getInstrument(id);
  const holder = before ? replay(before).state.holder : null;
  const mask = maskEmail(email);
  const inst = await act(
    id,
    expectSeq,
    { type: 'offer', to: { name: input.toName, ...(input.toRef?.trim() ? { ref: input.toRef.trim() } : {}) }, toMask: mask, tokenHash: input.tokenHash, expiresAt: input.expiresAt, holderSig: input.holderSig },
    by,
  );

  await mkdir(outDir(), { recursive: true });
  const entry: OutboxEntry = { instrument: id, email, by, createdAt: new Date().toISOString() };
  await writeFile(path.join(outDir(), `${input.tokenHash}.json`), JSON.stringify(entry), { mode: 0o600 });

  const link = `${baseUrl}/claim/${id}?t=${input.token}`;
  const expires = new Date(input.expiresAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  let emailed = false;
  let reason: string | undefined;
  if (mailConfigured()) {
    const m = offerEmail({ senderName: holder?.name ?? 'A Sovfren Companion', link, expires });
    const r = await sendMail({ to: email, ...m });
    emailed = r.sent;
    reason = r.reason;
  } else {
    reason = 'Email is not set up on this server yet.';
  }

  // The registry records that it sent (or could not send) the notice. This is a record only; it does not move ownership.
  let latest = inst;
  try {
    latest = await act(id, inst.events[inst.events.length - 1].seq, { type: 'notice', status: emailed ? 'sent' : 'not sent', toMask: mask, note: emailed ? undefined : reason }, 'registry');
  } catch {
    // the offer stands even if this record could not be added
  }
  return { inst: latest, link, emailed, reason, mask };
}

// ---------- the recipient's side (public pages) ----------

/** The open offer that this code belongs to, or null if the code is wrong, used, withdrawn or expired. */
export function offerFor(inst: Instrument, token: string) {
  if (!HEX64.test(token)) return null;
  const o = replay(inst).state.offer;
  if (!o || sha256(token) !== o.tokenHash || Date.parse(o.expiresAt) < Date.now()) return null;
  return o;
}

// Slows down guessing and abuse of the public claim page. In memory, per address.
const hits = new Map<string, number[]>();
export function tooManyTries(ip: string, max = 30, windowMs = 10 * 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > max;
}
