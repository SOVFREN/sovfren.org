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
import { act, getInstrument, listInstruments, replay, root, type Instrument } from './etd';
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
  email?: string; // email offers
  by: string;
  createdAt: string;
  // Postal offers: where to send it. Kept only here, in the registry's private store, until the offer ends.
  channel?: 'post';
  token?: string; // so the claim slip can be reprinted (a postal pack can jam or go missing)
  addressee?: string;
  address?: PostAddress;
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

// ---------- print and recorded delivery ----------
// The same offer and claim as email, but the one-time code is printed on a claim slip and posted with a copy of the
// instrument by recorded delivery. The registry records each step (requested, printed, posted with its tracking number,
// delivered) in the instrument's history. The recipient then claims online with the slip; acceptance is the delivery.

export interface PostAddress {
  line1: string;
  line2?: string;
  town: string;
  postcode?: string;
  country: string;
}

export interface PostInput {
  addressee: string; // who the letter is addressed to
  toName: string; // who the instrument is offered to ("Bearer" for a bearer note)
  toRef?: string;
  address: PostAddress;
  token: string;
  tokenHash: string;
  expiresAt: string;
  holderSig: string;
}

const tidy = (v: unknown, max: number) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

export async function sendByPost(id: string, expectSeq: number, input: PostInput, by: string): Promise<Instrument> {
  const addressee = tidy(input.addressee, 120);
  const a: PostAddress = {
    line1: tidy(input.address.line1, 100),
    ...(tidy(input.address.line2, 100) ? { line2: tidy(input.address.line2, 100) } : {}),
    town: tidy(input.address.town, 60),
    ...(tidy(input.address.postcode, 20) ? { postcode: tidy(input.address.postcode, 20) } : {}),
    country: tidy(input.address.country, 60),
  };
  if (!addressee || !a.line1 || !a.town || !a.country) throw new Error('Enter the name and postal address (first line, town and country).');
  if (!HEX64.test(input.token) || !HEX64.test(input.tokenHash) || sha256(input.token) !== input.tokenHash) {
    throw new Error('The one-time code was not made properly. Reload the page and try again.');
  }
  if ((await sentToday(by)) >= DAILY_LIMIT) throw new Error('You have reached the limit of offers for today. Try again tomorrow.');

  const mask = `${a.town}, ${a.country}`;
  const inst = await act(
    id,
    expectSeq,
    { type: 'offer', channel: 'post', to: { name: input.toName, ...(input.toRef?.trim() ? { ref: input.toRef.trim() } : {}) }, toMask: mask, tokenHash: input.tokenHash, expiresAt: input.expiresAt, holderSig: input.holderSig },
    by,
  );

  await mkdir(outDir(), { recursive: true });
  const entry: OutboxEntry = { instrument: id, channel: 'post', token: input.token, addressee, address: a, by, createdAt: new Date().toISOString() };
  await writeFile(path.join(outDir(), `${input.tokenHash}.json`), JSON.stringify(entry), { mode: 0o600 });
  try {
    return await act(id, inst.events[inst.events.length - 1].seq, { type: 'notice', channel: 'post', status: 'requested', toMask: mask }, 'registry');
  } catch {
    return inst; // the offer stands even if this record could not be added
  }
}

export interface PostJob {
  tokenHash: string;
  instrument: string;
  token: string;
  addressee: string;
  address: PostAddress;
  by: string;
  createdAt: string;
}

export async function getPostJob(tokenHash: string): Promise<PostJob | null> {
  if (!HEX64.test(tokenHash)) return null;
  try {
    const e = JSON.parse(await readFile(path.join(outDir(), `${tokenHash}.json`), 'utf8')) as OutboxEntry;
    if (e.channel !== 'post' || !e.token || !e.addressee || !e.address) return null;
    return { tokenHash, instrument: e.instrument, token: e.token, addressee: e.addressee, address: e.address, by: e.by, createdAt: e.createdAt };
  } catch {
    return null;
  }
}

/** Where a postal offer has got to, from the history: the latest postal step recorded since it was offered. */
export function postProgress(inst: Instrument) {
  let offerAt = -1;
  inst.events.forEach((e, i) => {
    if (e.type === 'offer' && (e.data as { channel?: string }).channel === 'post') offerAt = i;
  });
  if (offerAt < 0) return null;
  const steps = inst.events
    .slice(offerAt)
    .filter((e) => e.type === 'notice' && (e.data as { channel?: string }).channel === 'post')
    .map((e) => ({ at: e.at, ...(e.data as { status: string; carrier?: string; tracking?: string; note?: string; toMask: string }) }));
  const latest = steps[steps.length - 1];
  const withTracking = [...steps].reverse().find((s) => s.tracking);
  return {
    steps,
    status: latest?.status ?? 'requested',
    carrier: withTracking?.carrier,
    tracking: withTracking?.tracking,
    toMask: (inst.events[offerAt].data as { toMask?: string }).toMask ?? '',
  };
}

export async function recordPostStep(
  id: string,
  step: string,
  extra: { carrier?: string; tracking?: string; note?: string },
  by: string,
): Promise<Instrument> {
  const inst = await getInstrument(id);
  if (!inst) throw new Error('Not found.');
  const p = postProgress(inst);
  if (!p) throw new Error('This instrument has not been offered by post.');
  return act(id, inst.events[inst.events.length - 1].seq, { type: 'notice', channel: 'post', status: step, toMask: p.toMask, ...extra }, by);
}

/** Every instrument that has an open postal offer, for the postal queue. */
export async function listPostQueue() {
  const rows = [];
  for (const inst of await listInstruments()) {
    const st = replay(inst).state;
    const p = postProgress(inst);
    if (p && st.offer?.channel === 'post' && st.status === 'active') rows.push({ inst, offer: st.offer, progress: p });
  }
  return rows.sort((x, y) => x.offer.at.localeCompare(y.offer.at));
}

/** Finds an instrument by its printed serial number (ETD-2026-000001), for the claim page. */
export async function findBySerial(serial: string): Promise<Instrument | null> {
  const s = serial.trim().toUpperCase();
  if (!/^ETD-\d{4}-\d{6}$/.test(s)) return null;
  return (await listInstruments()).find((i) => i.terms.serial === s) ?? null;
}
