// Certificate of the Identity records and application workflow.
//
// One JSON record per Companion Number under ID_MARKS_DIR/cards. A Companion
// applies (status "submitted"); an admin reviews their Declaration of Life in
// person, then approves (setting Title and the AOL apostille number), rejects
// with a reason, or later revokes. Every change is appended to `history`.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAdminCompanion } from './admin';

export type CardStatus = 'submitted' | 'approved' | 'rejected' | 'revoked';

export interface CardEvent {
  at: string;
  by: string;
  action: string;
  note?: string;
}

export interface CardRecord {
  companionNumber: string;
  name: string;
  status: CardStatus;
  requestedTitle: string;
  statement: string;
  title?: string; // set on approval
  aol?: string; // apostille number, set on approval
  postRef?: string; // Registered Post reference of the posted Declaration of Life (barcode)
  declarationName?: string; // original filename of the uploaded Declaration of Life, Jurisdiction and Private Commerce
  declarationAt?: string;
  affidavitName?: string; // original filename of the uploaded Affidavit of Status
  affidavitAt?: string;
  submittedAt?: string;
  decidedAt?: string;
  rejectionReason?: string;
  history: CardEvent[];
}

const dir = () => path.resolve(import.meta.env.ID_MARKS_DIR ?? 'data/id-marks', 'cards');

const validNumber = (n: string) => /^[A-Za-z0-9]+$/.test(n);

export async function getCard(companionNumber?: string | null): Promise<CardRecord | null> {
  if (!companionNumber || !validNumber(companionNumber)) return null;
  try {
    return JSON.parse(await readFile(path.join(dir(), `${companionNumber}.json`), 'utf8')) as CardRecord;
  } catch {
    return null;
  }
}

async function write(card: CardRecord): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(path.join(dir(), `${card.companionNumber}.json`), JSON.stringify(card, null, 2));
}

function log(card: CardRecord, by: string, action: string, note?: string): void {
  card.history.push({ at: new Date().toISOString(), by, action, ...(note ? { note } : {}) });
}

export async function listCards(): Promise<CardRecord[]> {
  try {
    const files = await readdir(dir());
    const cards = await Promise.all(
      files.filter((f) => f.endsWith('.json')).map((f) => getCard(f.slice(0, -5))),
    );
    return cards.filter((c): c is CardRecord => c !== null);
  } catch {
    return [];
  }
}

// The approved card, or null — this is what decides whether a Companion gets the card.
export async function getGrant(companionNumber?: string | null): Promise<CardRecord | null> {
  const card = await getCard(companionNumber);
  return card?.status === 'approved' ? card : null;
}

// Admins can always use the card tools; everyone else needs an approved card.
export async function canUseIdCard(companionNumber?: string | null): Promise<boolean> {
  return isAdminCompanion(companionNumber) || (await getGrant(companionNumber)) !== null;
}

// Registered Post reference numbers follow the UPU S10 format: two letters,
// eight digits, a check digit, then a two-letter country code (e.g. NZ141668707GB).
export function normalisePostRef(input: string): string | null {
  const ref = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(ref) ? ref : null;
}

// S10 check digit: weighted sum of the eight serial digits (weights 8,6,4,2,3,5,9,7).
// Informational only — the reviewer sees whether it matches.
export function postRefCheckDigitValid(ref: string): boolean {
  const digits = ref.slice(2, 11).split('').map(Number);
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  const check = 11 - (sum % 11);
  return (check === 10 ? 0 : check === 11 ? 5 : check) === digits[8];
}

export interface ApplicationInput {
  requestedTitle: string;
  statement: string;
  postRef: string;
  declarationName?: string; // set when a new document was uploaded with this submission
  affidavitName?: string;
}

// Companion submits (or resubmits after a rejection/revocation). Approved cards
// can't be re-applied for; their marks are updated in place via noteMarksUpdated.
export async function submitApplication(
  companionNumber: string,
  name: string,
  input: ApplicationInput,
): Promise<CardRecord> {
  const existing = await getCard(companionNumber);
  if (existing?.status === 'approved' || existing?.status === 'submitted') {
    throw new Error('Application already in progress or approved');
  }
  const card: CardRecord = existing ?? {
    companionNumber,
    name,
    status: 'submitted',
    requestedTitle: '',
    statement: '',
    history: [],
  };
  card.name = name;
  card.status = 'submitted';
  card.requestedTitle = input.requestedTitle;
  card.statement = input.statement;
  card.postRef = input.postRef;
  if (input.declarationName) {
    card.declarationName = input.declarationName;
    card.declarationAt = new Date().toISOString();
  }
  if (input.affidavitName) {
    card.affidavitName = input.affidavitName;
    card.affidavitAt = new Date().toISOString();
  }
  card.submittedAt = new Date().toISOString();
  delete card.rejectionReason;
  log(card, companionNumber, existing ? 'resubmitted' : 'submitted');
  await write(card);
  return card;
}

export async function setPostRef(companionNumber: string, by: string, postRef: string): Promise<void> {
  const card = await getCard(companionNumber);
  if (!card) throw new Error('No such card');
  card.postRef = postRef;
  log(card, by, 'post reference changed', postRef);
  await write(card);
}

export async function noteMarksUpdated(
  companionNumber: string,
  declarationName?: string,
  affidavitName?: string,
): Promise<void> {
  const card = await getCard(companionNumber);
  if (!card) return;
  if (declarationName) {
    card.declarationName = declarationName;
    card.declarationAt = new Date().toISOString();
    log(card, companionNumber, 'declaration replaced', declarationName);
  }
  if (affidavitName) {
    card.affidavitName = affidavitName;
    card.affidavitAt = new Date().toISOString();
    log(card, companionNumber, 'affidavit replaced', affidavitName);
  }
  log(card, companionNumber, 'marks updated');
  await write(card);
}

export async function approveCard(
  companionNumber: string,
  by: string,
  input: { title: string; aol: string; postRef?: string; name?: string },
): Promise<void> {
  const card: CardRecord = (await getCard(companionNumber)) ?? {
    companionNumber,
    name: input.name ?? '',
    status: 'submitted',
    requestedTitle: input.title,
    statement: '',
    history: [],
  };
  card.status = 'approved';
  card.title = input.title;
  card.aol = input.aol;
  if (input.postRef) card.postRef = input.postRef;
  card.decidedAt = new Date().toISOString();
  delete card.rejectionReason;
  log(card, by, 'approved', `${input.title} · AOL ${input.aol}`);
  await write(card);
}

export async function rejectCard(companionNumber: string, by: string, reason: string): Promise<void> {
  const card = await getCard(companionNumber);
  if (!card) throw new Error('No such application');
  card.status = 'rejected';
  card.rejectionReason = reason;
  card.decidedAt = new Date().toISOString();
  log(card, by, 'rejected', reason);
  await write(card);
}

export async function revokeCard(companionNumber: string, by: string, reason: string): Promise<void> {
  const card = await getCard(companionNumber);
  if (!card) throw new Error('No such card');
  card.status = 'revoked';
  card.decidedAt = new Date().toISOString();
  log(card, by, 'revoked', reason);
  await write(card);
}

export async function addNote(companionNumber: string, by: string, note: string): Promise<void> {
  const card = await getCard(companionNumber);
  if (!card) throw new Error('No such card');
  log(card, by, 'note', note);
  await write(card);
}

// Sending State is the Companion's surname. Prefer the Register record's
// familyName; otherwise take what follows the colon in "Michael-ian : CURRY",
// or the last word.
export function surnameFrom(name: string, familyName?: string | null): string {
  if (familyName) return familyName;
  const afterColon = name.split(':').pop()?.trim();
  if (name.includes(':') && afterColon) return afterColon;
  return name.trim().split(/\s+/).pop() ?? name;
}

// Name field on the card is the given name only (the surname goes in Sending
// State). Keeps the trailing colon used in the Society's name style, e.g.
// "Michael-ian : CURRY" -> "Michael-ian:".
export function firstNameFrom(name: string, familyName?: string | null): string {
  const trimmed = name.trim();
  if (trimmed.includes(':')) {
    const given = trimmed.split(':')[0].trim();
    return given ? `${given}:` : trimmed;
  }
  if (familyName && trimmed.toLowerCase().endsWith(familyName.trim().toLowerCase())) {
    const given = trimmed.slice(0, trimmed.length - familyName.trim().length).trim();
    if (given) return given;
  }
  const words = trimmed.split(/\s+/);
  return words.length > 1 ? words.slice(0, -1).join(' ') : trimmed;
}
