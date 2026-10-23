// Autograph, private seal, estate heraldry and the scanned Declaration of Life,
// Jurisdiction and Private Commerce, and the Affidavit of Status for the Certificate of the Identity card.
// Stored on this server (not SovfHub), one folder per Companion Number, and
// only ever served back to that signed-in Companion (or an admin reviewing their
// application) by portal/id-marks/[kind].

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type MarkKind = 'seal' | 'heraldry' | 'signature' | 'declaration' | 'affidavit';
export const MARK_KINDS: MarkKind[] = ['seal', 'heraldry', 'signature', 'declaration', 'affidavit'];

// Scanned documents: may be PDFs, larger, and are only ever downloaded.
export const DOCUMENT_KINDS: MarkKind[] = ['declaration', 'affidavit'];

// Only the documents may be PDFs (scans of signed documents), and they may be larger.
const MAX_BYTES: Record<MarkKind, number> = {
  seal: 4 * 1024 * 1024,
  heraldry: 4 * 1024 * 1024,
  signature: 4 * 1024 * 1024,
  declaration: 15 * 1024 * 1024,
  affidavit: 15 * 1024 * 1024,
};

const baseDir = () => path.resolve(import.meta.env.ID_MARKS_DIR ?? 'data/id-marks');

function fileFor(companionNumber: string, kind: MarkKind): string {
  if (!/^[A-Za-z0-9]+$/.test(companionNumber)) throw new Error('Invalid Companion Number');
  return path.join(baseDir(), companionNumber, `${kind}.img`);
}

function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return null;
}

export async function saveMark(companionNumber: string, kind: MarkKind, bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0 || bytes.length > MAX_BYTES[kind]) throw new Error('File is empty or too large');
  const type = sniff(bytes);
  if (!type || (type === 'application/pdf' && !DOCUMENT_KINDS.includes(kind))) throw new Error('Unsupported file type');
  const file = fileFor(companionNumber, kind);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

export async function saveSignatureDataUrl(companionNumber: string, dataUrl: string): Promise<void> {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Invalid signature');
  await saveMark(companionNumber, 'signature', Buffer.from(match[1], 'base64'));
}

export async function readMark(
  companionNumber: string,
  kind: MarkKind,
): Promise<{ bytes: Buffer; type: string } | null> {
  try {
    const bytes = await readFile(fileFor(companionNumber, kind));
    return { bytes, type: sniff(bytes) ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

export async function hasMark(companionNumber: string, kind: MarkKind): Promise<boolean> {
  return (await readMark(companionNumber, kind)) !== null;
}

export async function deleteMark(companionNumber: string, kind: MarkKind): Promise<void> {
  await rm(fileFor(companionNumber, kind), { force: true });
}
