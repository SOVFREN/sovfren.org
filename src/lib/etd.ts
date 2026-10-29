// Electronic Trade Documents (ETD): Promissory Notes and Bills of Exchange.
//
// Anti-fraud model
//  - The instrument terms are canonicalised (sorted-key JSON), hashed with
//    SHA-256 and signed with Ed25519. Any edit changes the hash and breaks the
//    signature.
//  - Every later act (transfer, delivery, acceptance, payment, cancellation) is
//    an event in an append-only chain. Each event commits to the previous
//    event's hash and is signed, so history can't be reordered, dropped or
//    rewritten without detection.
//  - Copies are not prevented by cryptography (any file can be copied). What
//    prevents unauthorised duplication is *control*: this registry holds the one
//    authoritative chain, and only the current holder per that chain is
//    recognised. A copy is only ever a view; its status is checked here.
//    Transfers are serialised per instrument and must name the current holder
//    and the next sequence number, so a double-spend is rejected.
//  - verifyInstrument() re-derives everything from scratch, and an exported
//    bundle can be verified offline with the public key alone.
//
// Records are one JSON file per instrument under ETD_DIR/instruments.
// Signing key: ETD_SIGNING_KEY (PKCS8 PEM; "\n" escapes allowed) or, failing
// that, one generated into ETD_DIR/keys on first use. Prefer the env var, kept
// outside the data directory, in production.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { identifierChecks, validBic, validLei, type IdentifierKey } from './identifiers';

export type InstrumentType = 'promissory_note' | 'bill_of_exchange';
export type EventType = 'issue' | 'transfer' | 'deliver' | 'accept' | 'pay' | 'cancel' | 'rekey' | 'recover';
export type Status = 'active' | 'paid' | 'cancelled';

export interface Party {
  name: string;
  ref?: string; // Companion Number or other identifier
  lei?: string; // Legal Entity Identifier (ISO 17442)
  bic?: string; // bank identifier code (ISO 9362)
}

// Assigned by others and only validated here, never generated.
export interface Identifiers {
  isin?: string;
  sedol?: string;
  cusip?: string;
  cfi?: string;
}

export interface Terms {
  type: InstrumentType;
  serial: string;
  nonce: string; // random, so two otherwise identical instruments never share a hash
  amount: string; // decimal string, e.g. "12500.00"
  currency: string; // ISO 4217
  issuedAt: string; // ISO date
  placeOfIssue: string;
  payableOn: string; // ISO date or "on demand"
  payee: Party; // payable to the order of
  payeeKey: string; // payee's Ed25519 public key (raw, base64): only they can endorse onward
  maker?: Party; // promissory note: the promisor
  drawer?: Party; // bill of exchange: who orders payment
  drawee?: Party; // bill of exchange: who must pay
  interest?: string;
  governingLaw?: string;
  identifiers?: Identifiers;
  clauses?: string;
}

export interface EtdEvent {
  seq: number;
  type: EventType;
  at: string;
  by: string; // admin Companion Number who recorded it
  data: Record<string, unknown>;
  prevHash: string; // seq 0: document hash; else previous event hash
  hash: string;
  kid: string;
  sig: string;
}

export interface Instrument {
  id: string; // = document hash (hex)
  terms: Terms;
  kid: string;
  sig: string; // signature over the document hash
  events: EtdEvent[];
}

export interface State {
  status: Status;
  holder: Party;
  holderKey: string;
  accepted: boolean;
  delivered?: { to: Party; at: string; method: string };
  headHash: string;
}

export interface Verification {
  ok: boolean;
  errors: string[];
  state?: State;
}

// Read at runtime first: Astro bakes import.meta.env values in at build time, so a
// variable set only on the running server would otherwise be ignored.
const etdEnv = (name: 'ETD_DIR' | 'ETD_SIGNING_KEY'): string | undefined => process.env[name] || import.meta.env[name] || undefined;
export const root = () => path.resolve(etdEnv('ETD_DIR') ?? 'data/etd');
const instDir = () => path.join(root(), 'instruments');
const keyDir = () => path.join(root(), 'keys');

// ---------- canonical form & hashing ----------

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hashTerms = (t: Terms) => sha256(`etd-doc-v1\n${canonical(t)}`);
const eventBody = (e: Omit<EtdEvent, 'hash' | 'sig'>) => `etd-event-v1\n${canonical(e)}`;

// ---------- keys ----------

let cached: { priv: KeyObject; pub: KeyObject; kid: string } | null = null;

const kidOf = (pub: KeyObject) =>
  sha256(pub.export({ type: 'spki', format: 'der' }) as Buffer).slice(0, 16);

async function signingKey() {
  if (cached) return cached;
  let priv: KeyObject;
  const env = etdEnv('ETD_SIGNING_KEY');
  if (env) {
    priv = createPrivateKey(env.replace(/\\n/g, '\n'));
  } else {
    const file = path.join(keyDir(), 'signing-key.pem');
    try {
      priv = createPrivateKey(await readFile(file, 'utf8'));
    } catch {
      await mkdir(keyDir(), { recursive: true });
      const pair = generateKeyPairSync('ed25519');
      priv = pair.privateKey;
      await writeFile(file, priv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      await chmod(file, 0o600).catch(() => {});
    }
  }
  const pub = createPublicKey(priv);
  const kid = kidOf(pub);
  await mkdir(keyDir(), { recursive: true });
  await writeFile(path.join(keyDir(), `${kid}.pub.pem`), pub.export({ type: 'spki', format: 'pem' }));
  cached = { priv, pub, kid };
  return cached;
}

export async function publicKeyPem(kid: string): Promise<string | null> {
  if (!/^[0-9a-f]{16}$/.test(kid)) return null;
  try {
    return await readFile(path.join(keyDir(), `${kid}.pub.pem`), 'utf8');
  } catch {
    return null;
  }
}

// ---------- validation ----------

const cleanParty = (p: unknown, label: string): Party => {
  const o = (p ?? {}) as Party;
  const name = String(o.name ?? '').trim();
  const ref = String(o.ref ?? '').trim();
  if (!name || name.length > 120) throw new Error(`${label}: enter a name (up to 120 characters).`);
  if (ref.length > 60) throw new Error(`${label}: reference too long.`);
  const lei = String(o.lei ?? '').trim().toUpperCase();
  if (lei && !validLei(lei)) throw new Error(`${label}: that LEI is not valid (check the 20 characters).`);
  const bic = String(o.bic ?? '').trim().toUpperCase();
  if (bic && !validBic(bic)) throw new Error(`${label}: that BIC is not valid.`);
  return { name, ...(ref ? { ref } : {}), ...(lei ? { lei } : {}), ...(bic ? { bic } : {}) };
};

const cleanIdentifiers = (input?: Identifiers): Identifiers | undefined => {
  const out: Identifiers = {};
  for (const k of Object.keys(identifierChecks) as IdentifierKey[]) {
    const v = String(input?.[k] ?? '').replace(/\s/g, '').toUpperCase();
    if (!v) continue;
    if (!identifierChecks[k](v)) throw new Error(`${k.toUpperCase()} "${v}" is not valid (format or check digit is wrong).`);
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
};

// ---------- holder keys ----------
// Holders sign their own acts (transfer, payment, key change) in their browser
// with an Ed25519 key the server never sees. Keys travel as raw 32-byte public
// keys, base64. The key that made a party the holder (payeeKey at issue, toKey
// at transfer) is recorded in the chain, so the chain verifies on its own.

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function validHolderKey(b64: string): boolean {
  const raw = Buffer.from(b64, 'base64');
  return raw.length === 32 && raw.toString('base64') === b64;
}

const cleanKey = (k: unknown, label: string): string => {
  const key = String(k ?? '').trim();
  if (!validHolderKey(key)) throw new Error(`${label}: not a valid public key.`);
  return key;
};

// The exact text a holder signs. The browser rebuilds this same string.
export const actMessage = (id: string, seq: number, prevHash: string, type: string, args: string[] = []) =>
  ['etd-act-v1', id, String(seq), prevHash, type, ...args].join('\n');

function holderSigOk(key: string, message: string, sig: unknown): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(key, 'base64')]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(message), pub, Buffer.from(String(sig ?? ''), 'base64'));
  } catch {
    return false;
  }
}

const sameParty = (a: Party, b: Party) =>
  a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
  (a.ref ?? '').toLowerCase() === (b.ref ?? '').toLowerCase();

const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export interface IssueInput {
  type: InstrumentType;
  amount: string;
  currency: string;
  issuedAt: string;
  placeOfIssue: string;
  payableOn: string;
  payee: Party;
  payeeKey: string;
  maker?: Party;
  drawer?: Party;
  drawee?: Party;
  interest?: string;
  governingLaw?: string;
  identifiers?: Identifiers;
  clauses?: string;
}

// ---------- storage with per-instrument locking ----------

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  next.finally(() => locks.get(id) === next && locks.delete(id)).catch(() => {});
  return next;
}

const validId = (id: string) => /^[0-9a-f]{64}$/.test(id);

export async function getInstrument(id: string): Promise<Instrument | null> {
  if (!validId(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(instDir(), `${id}.json`), 'utf8')) as Instrument;
  } catch {
    return null;
  }
}

async function save(inst: Instrument): Promise<void> {
  await mkdir(instDir(), { recursive: true });
  const file = path.join(instDir(), `${inst.id}.json`);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(inst, null, 2));
  await rename(tmp, file); // atomic replace: a crash never leaves a half-written chain
}

export async function listInstruments(): Promise<Instrument[]> {
  try {
    const files = await readdir(instDir());
    const all = await Promise.all(
      files.filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).map((f) => getInstrument(f.slice(0, -5))),
    );
    return all.filter((i): i is Instrument => i !== null);
  } catch {
    return [];
  }
}

async function nextSerial(year: number): Promise<string> {
  const used = (await listInstruments()).filter((i) => i.terms.serial.startsWith(`ETD-${year}-`)).length;
  return `ETD-${year}-${String(used + 1).padStart(6, '0')}`;
}

// ---------- events ----------

async function makeEvent(
  seq: number,
  type: EventType,
  by: string,
  data: Record<string, unknown>,
  prevHash: string,
): Promise<EtdEvent> {
  const { priv, kid } = await signingKey();
  const base = { seq, type, at: new Date().toISOString(), by, data, prevHash, kid };
  const hash = sha256(eventBody(base));
  const sig = edSign(null, Buffer.from(hash, 'hex'), priv).toString('base64');
  return { ...base, hash, sig };
}

export async function issue(input: IssueInput, by: string): Promise<Instrument> {
  const type = input.type;
  if (type !== 'promissory_note' && type !== 'bill_of_exchange') throw new Error('Choose an instrument type.');
  const amount = input.amount.trim();
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error('Enter a valid amount (e.g. 12500.00).');
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a 3-letter code.');
  if (!isoDate(input.issuedAt)) throw new Error('Enter a valid issue date.');
  const payableOn = input.payableOn.trim().toLowerCase() === 'on demand' ? 'on demand' : input.payableOn.trim();
  if (payableOn !== 'on demand' && !isoDate(payableOn)) throw new Error('Payable on must be a date or "on demand".');
  if (payableOn !== 'on demand' && payableOn < input.issuedAt) throw new Error('Payable on cannot be before the issue date.');
  const place = input.placeOfIssue.trim();
  if (!place || place.length > 120) throw new Error('Enter the place of issue.');

  const year = new Date().getUTCFullYear();
  const terms: Terms = {
    type,
    serial: '',
    nonce: randomBytes(16).toString('hex'),
    amount,
    currency,
    issuedAt: input.issuedAt,
    placeOfIssue: place,
    payableOn,
    payee: cleanParty(input.payee, 'Payee'),
    payeeKey: cleanKey(input.payeeKey, 'Payee public key'),
    ...(type === 'promissory_note'
      ? { maker: cleanParty(input.maker, 'Maker') }
      : { drawer: cleanParty(input.drawer, 'Drawer'), drawee: cleanParty(input.drawee, 'Drawee') }),
    ...(input.interest?.trim() ? { interest: input.interest.trim().slice(0, 120) } : {}),
    ...(input.governingLaw?.trim() ? { governingLaw: input.governingLaw.trim().slice(0, 120) } : {}),
    ...(cleanIdentifiers(input.identifiers) ? { identifiers: cleanIdentifiers(input.identifiers) } : {}),
    ...(input.clauses?.trim() ? { clauses: input.clauses.trim().slice(0, 4000) } : {}),
  };

  return withLock('__issue__', async () => {
    terms.serial = await nextSerial(year);
    const id = hashTerms(terms);
    if (await getInstrument(id)) throw new Error('An identical instrument already exists.');
    const { priv, kid } = await signingKey();
    const sig = edSign(null, Buffer.from(id, 'hex'), priv).toString('base64');
    const first = await makeEvent(0, 'issue', by, {}, id);
    const inst: Instrument = { id, terms, kid, sig, events: [first] };
    await save(inst);
    return inst;
  });
}

// ---------- state machine (shared by apply and verify) ----------

function initialState(terms: Terms, docHash: string): State {
  return { status: 'active', holder: terms.payee, holderKey: terms.payeeKey, accepted: false, headHash: docHash };
}

// Returns an error string if the event is not legal in this state, else mutates state.
function step(terms: Terms, s: State, e: EtdEvent, docId: string): string | null {
  if (s.status !== 'active') return `event ${e.seq}: instrument is already ${s.status}`;
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case 'issue':
      return `event ${e.seq}: unexpected issue event`;
    case 'transfer': {
      const from = d.from as Party, to = d.to as Party;
      if (!from?.name || !to?.name) return `event ${e.seq}: transfer needs from and to`;
      if (!sameParty(from, s.holder)) return `event ${e.seq}: transferor is not the current holder`;
      if (sameParty(to, s.holder)) return `event ${e.seq}: transfer to the same holder`;
      const toKey = String(d.toKey ?? '');
      if (!validHolderKey(toKey)) return `event ${e.seq}: new holder has no valid public key`;
      const msg = actMessage(docId, e.seq, e.prevHash, 'transfer', [to.name, to.ref ?? '', toKey]);
      if (!holderSigOk(s.holderKey, msg, d.holderSig)) return `event ${e.seq}: transfer is not signed by the current holder's key`;
      s.holder = to;
      s.holderKey = toKey;
      s.delivered = undefined; // the new holder has not yet received it
      return null;
    }
    case 'deliver': {
      const to = d.to as Party;
      if (!to?.name) return `event ${e.seq}: delivery needs a recipient`;
      if (!sameParty(to, s.holder)) return `event ${e.seq}: delivery must be to the current holder`;
      s.delivered = { to, at: e.at, method: String(d.method ?? '') };
      return null;
    }
    case 'accept':
      if (terms.type !== 'bill_of_exchange') return `event ${e.seq}: only a bill of exchange can be accepted`;
      if (s.accepted) return `event ${e.seq}: already accepted`;
      s.accepted = true;
      return null;
    case 'pay':
      if (!holderSigOk(s.holderKey, actMessage(docId, e.seq, e.prevHash, 'pay'), d.holderSig))
        return `event ${e.seq}: payment is not acknowledged by the current holder's key`;
      s.status = 'paid';
      return null;
    case 'rekey': {
      const newKey = String(d.newKey ?? '');
      if (!validHolderKey(newKey)) return `event ${e.seq}: invalid new key`;
      if (!holderSigOk(s.holderKey, actMessage(docId, e.seq, e.prevHash, 'rekey', [newKey]), d.holderSig))
        return `event ${e.seq}: key change is not signed by the current holder's key`;
      s.holderKey = newKey;
      return null;
    }
    case 'recover': {
      // Registry-witnessed replacement for a lost key. Signed by the registry only,
      // so it is flagged in the history; the admin must have verified the holder in person.
      const newKey = String(d.newKey ?? '');
      if (!validHolderKey(newKey)) return `event ${e.seq}: invalid new key`;
      if (!String(d.reason ?? '').trim()) return `event ${e.seq}: key recovery needs a reason`;
      s.holderKey = newKey;
      return null;
    }
    case 'cancel':
      if (!String(d.reason ?? '').trim()) return `event ${e.seq}: cancellation needs a reason`;
      s.status = 'cancelled';
      return null;
    default:
      return `event ${e.seq}: unknown type`;
  }
}

export function replay(inst: Instrument): { state: State; error?: string } {
  const state = initialState(inst.terms, inst.id);
  for (const e of inst.events.slice(1)) {
    const err = step(inst.terms, state, e, inst.id);
    if (err) return { state, error: err };
    state.headHash = e.hash;
  }
  state.headHash = inst.events[inst.events.length - 1]?.hash ?? inst.id;
  return { state };
}

// ---------- verification ----------

export async function verifyInstrument(
  inst: Instrument,
  keyLookup: (kid: string) => Promise<string | null> = publicKeyPem,
): Promise<Verification> {
  const errors: string[] = [];
  const keys = new Map<string, KeyObject | null>();
  const key = async (kid: string) => {
    if (!keys.has(kid)) {
      const pem = await keyLookup(kid);
      keys.set(kid, pem ? createPublicKey(pem) : null);
    }
    return keys.get(kid)!;
  };

  if (hashTerms(inst.terms) !== inst.id) errors.push('Document terms do not match the document hash (altered).');
  const docKey = await key(inst.kid);
  if (!docKey) errors.push(`Unknown signing key ${inst.kid}.`);
  else if (!edVerify(null, Buffer.from(inst.id, 'hex'), docKey, Buffer.from(inst.sig, 'base64')))
    errors.push('Issuer signature on the document is invalid.');

  if (inst.events[0]?.type !== 'issue' || inst.events[0].seq !== 0) errors.push('Chain does not start with an issue event.');
  let prev = inst.id;
  for (const [i, e] of inst.events.entries()) {
    if (e.seq !== i) errors.push(`event ${i}: sequence number is ${e.seq}`);
    if (e.prevHash !== prev) errors.push(`event ${i}: does not link to the previous event`);
    const { hash, sig, ...base } = e;
    if (sha256(eventBody(base)) !== hash) errors.push(`event ${i}: content does not match its hash (altered)`);
    const k = await key(e.kid);
    if (!k) errors.push(`event ${i}: unknown signing key ${e.kid}`);
    else if (!edVerify(null, Buffer.from(hash, 'hex'), k, Buffer.from(sig, 'base64')))
      errors.push(`event ${i}: signature invalid`);
    prev = hash;
  }
  const { state, error } = replay(inst);
  if (error) errors.push(error);
  return { ok: errors.length === 0, errors, state };
}

// ---------- actions ----------

type Action =
  | { type: 'transfer'; to: Party; toKey: string; holderSig: string }
  | { type: 'deliver'; method: string; note?: string }
  | { type: 'accept' }
  | { type: 'pay'; note?: string; holderSig: string }
  | { type: 'cancel'; reason: string }
  | { type: 'rekey'; newKey: string; holderSig: string }
  | { type: 'recover'; newKey: string; reason: string };

// Appends one event. `expectSeq` is the sequence number the caller saw; if
// anything else has been recorded since, the action is refused (no double spend).
export async function act(id: string, expectSeq: number, action: Action, by: string): Promise<Instrument> {
  if (!validId(id)) throw new Error('Not found.');
  return withLock(id, async () => {
    const inst = await getInstrument(id);
    if (!inst) throw new Error('Not found.');
    const v = await verifyInstrument(inst);
    if (!v.ok || !v.state) throw new Error('This instrument failed verification; no further acts are allowed.');
    const last = inst.events[inst.events.length - 1];
    if (last.seq !== expectSeq) throw new Error('This instrument changed since you loaded it. Reload and try again.');

    let data: Record<string, unknown>;
    switch (action.type) {
      case 'transfer':
        data = { from: v.state.holder, to: cleanParty(action.to, 'New holder'), toKey: cleanKey(action.toKey, 'New holder public key'), holderSig: action.holderSig };
        break;
      case 'deliver':
        if (!action.method.trim()) throw new Error('Enter the delivery method.');
        data = { to: v.state.holder, method: action.method.trim().slice(0, 120), ...(action.note?.trim() ? { note: action.note.trim().slice(0, 500) } : {}) };
        break;
      case 'accept':
        data = { drawee: inst.terms.drawee };
        break;
      case 'pay':
        data = { holderSig: action.holderSig, ...(action.note?.trim() ? { note: action.note.trim().slice(0, 500) } : {}) };
        break;
      case 'cancel':
        data = { reason: action.reason.trim().slice(0, 500) };
        break;
      case 'rekey':
        data = { newKey: cleanKey(action.newKey, 'New key'), holderSig: action.holderSig };
        break;
      case 'recover':
        data = { newKey: cleanKey(action.newKey, 'New key'), reason: action.reason.trim().slice(0, 500) };
        break;
    }
    const event = await makeEvent(last.seq + 1, action.type, by, data, last.hash);
    const next: Instrument = { ...inst, events: [...inst.events, event] };
    const check = replay(next);
    if (check.error) throw new Error(check.error.replace(/^event \d+: /, ''));
    await save(next);
    return next;
  });
}

// Self-contained bundle: terms, chain and the public keys needed to verify it offline.
export async function exportBundle(inst: Instrument) {
  const kids = [...new Set([inst.kid, ...inst.events.map((e) => e.kid)])];
  const publicKeys: Record<string, string> = {};
  for (const k of kids) {
    const pem = await publicKeyPem(k);
    if (pem) publicKeys[k] = pem;
  }
  return { format: 'sovfren-etd-bundle-v1', algorithm: 'Ed25519/SHA-256', instrument: inst, publicKeys };
}

export const typeLabel = (t: InstrumentType) => (t === 'promissory_note' ? 'Promissory Note' : 'Bill of Exchange');

// Machine-readable view for custodians, banks and clearing agents. Field names
// follow ISO conventions (ISO 4217 currency, ISO 8601 dates, LEI, ISIN, CFI),
// but this is not an ISO 20022 message: a bank integration maps it onto its own.
// It describes the live registry state; the signed bundle is the proof.
export async function exportStandard(inst: Instrument, baseUrl: string) {
  const v = await verifyInstrument(inst);
  const t = inst.terms;
  return {
    schema: 'sovfren-etd-export-v1',
    instrument: {
      id: inst.id,
      serialNumber: t.serial,
      type: t.type === 'promissory_note' ? 'PROMISSORY_NOTE' : 'BILL_OF_EXCHANGE',
      ...t.identifiers,
      faceAmount: { value: t.amount, currency: t.currency },
      issueDate: t.issuedAt,
      maturity: t.payableOn === 'on demand' ? { onDemand: true } : { date: t.payableOn },
      placeOfIssue: t.placeOfIssue,
      governingLaw: t.governingLaw,
      interest: t.interest,
    },
    parties: {
      maker: t.maker,
      drawer: t.drawer,
      drawee: t.drawee,
      originalPayee: t.payee,
      currentHolder: v.state?.holder,
    },
    status: {
      state: v.state?.status,
      accepted: v.state?.accepted,
      delivered: v.state?.delivered,
      verified: v.ok,
      errors: v.errors,
      sequence: inst.events[inst.events.length - 1].seq,
      headHash: inst.events[inst.events.length - 1].hash,
      holderPublicKey: v.state?.holderKey,
    },
    history: inst.events.map((e) => ({ seq: e.seq, type: e.type, at: e.at, hash: e.hash })),
    proof: { algorithm: 'Ed25519/SHA-256', bundle: `${baseUrl}/portal/admin/etd/${inst.id}/bundle.json` },
  };
}
