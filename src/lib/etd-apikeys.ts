// Read-only API keys for counterparties, custodians and banks that need to
// check an instrument's status. Keys are shown once at creation; only a SHA-256
// hash is stored, so a leaked data file does not leak usable keys. A key can
// read instruments but can never change one.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ApiKeyRecord {
  id: string;
  label: string;
  prefix: string; // first characters of the key, to recognise it in the list
  hash: string;
  createdAt: string;
  createdBy: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

const file = () => path.resolve(process.env.ETD_DIR || import.meta.env.ETD_DIR || 'data/etd', 'api-keys.json');
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.catch(() => {}).then(fn);
  chain = next;
  return next;
};

async function load(): Promise<ApiKeyRecord[]> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as ApiKeyRecord[];
  } catch {
    return [];
  }
}

async function save(keys: ApiKeyRecord[]): Promise<void> {
  await mkdir(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
  await rename(tmp, file());
}

export const listApiKeys = load;

export function createApiKey(label: string, by: string): Promise<{ key: string; record: ApiKeyRecord }> {
  const clean = label.trim();
  if (!clean || clean.length > 80) return Promise.reject(new Error('Enter a label (up to 80 characters).'));
  return serial(async () => {
    const key = `etdk_${randomBytes(32).toString('base64url')}`;
    const record: ApiKeyRecord = {
      id: randomBytes(6).toString('hex'),
      label: clean,
      prefix: key.slice(0, 10),
      hash: hashKey(key),
      createdAt: new Date().toISOString(),
      createdBy: by,
    };
    await save([...(await load()), record]);
    return { key, record };
  });
}

export function revokeApiKey(id: string): Promise<void> {
  return serial(async () => {
    const keys = await load();
    const k = keys.find((x) => x.id === id);
    if (!k) throw new Error('No such key.');
    if (!k.revokedAt) k.revokedAt = new Date().toISOString();
    await save(keys);
  });
}

// ---- request authentication ----

const failures = new Map<string, { count: number; since: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 20;

export type AuthResult = { ok: true; key: ApiKeyRecord } | { ok: false; status: 401 | 429 };

export async function authenticate(authorization: string | null, client: string): Promise<AuthResult> {
  const f = failures.get(client);
  if (f && Date.now() - f.since < WINDOW_MS && f.count >= MAX_FAILURES) return { ok: false, status: 429 };

  const presented = /^Bearer (etdk_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1];
  const h = presented ? hashKey(presented) : null;
  const record = h ? (await load()).find((k) => k.hash === h && !k.revokedAt) : undefined;

  if (!record) {
    const cur = f && Date.now() - f.since < WINDOW_MS ? f : { count: 0, since: Date.now() };
    failures.set(client, { count: cur.count + 1, since: cur.since });
    return { ok: false, status: 401 };
  }
  // Record use at most once a minute, so reads don't rewrite the file each time.
  if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > 60_000) {
    void serial(async () => {
      const keys = await load();
      const k = keys.find((x) => x.id === record.id);
      if (k) {
        k.lastUsedAt = new Date().toISOString();
        await save(keys);
      }
    }).catch(() => {});
  }
  return { ok: true, key: record };
}
