// Certificate of the Identity grants. A grant is created by an admin after the
// Companion has shown their Declaration of Life (verified in person); it holds
// the card fields that are not pulled from SovfHub. Stored on this server as
// one JSON file per Companion Number under ID_MARKS_DIR/grants.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAdminCompanion } from './admin';

export interface CardGrant {
  companionNumber: string;
  title: string; // e.g. "Consul-General"
  aol: string; // apostille number
  grantedAt: string;
}

const dir = () => path.resolve(import.meta.env.ID_MARKS_DIR ?? 'data/id-marks', 'grants');

function fileFor(companionNumber: string): string {
  if (!/^[A-Za-z0-9]+$/.test(companionNumber)) throw new Error('Invalid Companion Number');
  return path.join(dir(), `${companionNumber}.json`);
}

export async function getGrant(companionNumber?: string | null): Promise<CardGrant | null> {
  if (!companionNumber || !/^[A-Za-z0-9]+$/.test(companionNumber)) return null;
  try {
    return JSON.parse(await readFile(fileFor(companionNumber), 'utf8')) as CardGrant;
  } catch {
    return null;
  }
}

export async function saveGrant(grant: Omit<CardGrant, 'grantedAt'>): Promise<void> {
  await mkdir(dir(), { recursive: true });
  const full: CardGrant = { ...grant, grantedAt: new Date().toISOString() };
  await writeFile(fileFor(grant.companionNumber), JSON.stringify(full, null, 2));
}

export async function revokeGrant(companionNumber: string): Promise<void> {
  await rm(fileFor(companionNumber), { force: true });
}

export async function listGrants(): Promise<CardGrant[]> {
  try {
    const files = await readdir(dir());
    const grants = await Promise.all(
      files.filter((f) => f.endsWith('.json')).map((f) => getGrant(f.slice(0, -5))),
    );
    return grants.filter((g): g is CardGrant => g !== null).sort((a, b) => a.companionNumber.localeCompare(b.companionNumber));
  } catch {
    return [];
  }
}

// Admins can always use the card tools; everyone else needs a grant.
export async function canUseIdCard(companionNumber?: string | null): Promise<boolean> {
  return isAdminCompanion(companionNumber) || (await getGrant(companionNumber)) !== null;
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
