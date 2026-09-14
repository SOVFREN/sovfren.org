// Thin client for the SovfHub API (https://sovfhub.com/api.php).
//
// Register endpoints (register_lookup / register_request_pin / register_unlock)
// are real and live. Property endpoints below are still a placeholder —
// SovfHub doesn't expose them yet. Companion identity/sign-in goes through
// SSO instead (see ../lib/sso.ts), not this file.

const API_URL = import.meta.env.SOVFHUB_API_URL;
const API_KEY = import.meta.env.SOVFHUB_API_KEY;

async function handle<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`SovfHub API ${action} failed: ${res.status}`);
  }
  const data = (await res.json()) as T & { error?: boolean; message?: string };
  if (data.error) {
    throw new Error(data.message ?? `SovfHub API ${action} returned an error`);
  }
  return data;
}

async function sovfhubGet<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams({ do: action, ...params });
  const res = await fetch(`${API_URL}?${query}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  return handle<T>(res, action);
}

async function sovfhubPost<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API_URL}?do=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  return handle<T>(res, action);
}

// Public Notices mutations act on behalf of a specific companion, so they
// authenticate with that companion's own SSO access token (from their
// portal session), not the server's static API_KEY.
async function sovfhubUserGet<T>(action: string, accessToken: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams({ do: action, ...params });
  const res = await fetch(`${API_URL}?${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return handle<T>(res, action);
}

async function sovfhubUserPost<T>(action: string, accessToken: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API_URL}?do=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  return handle<T>(res, action);
}

export interface RegisterRecord {
  companionNumber: string;
  status: 'valid' | 'expired' | 'revoked';
  membershipSubject: string; // e.g. "Man", "Woman" — printed as "This <subject> is..."
  firstName?: string;
  familyName?: string;
  credentials?: string | null;
  expiryDate?: string | null;
  swornAffidavit: boolean;
  fullRecordUnlocked: boolean;
}

export function getRegisterRecord(companionNumber: string) {
  return sovfhubGet<RegisterRecord>('register_lookup', { companion_number: companionNumber });
}

export function requestRegisterPin(companionNumber: string) {
  return sovfhubPost<{ sent: boolean }>('register_request_pin', { companion_number: companionNumber });
}

export function unlockRegisterRecord(companionNumber: string, pin: string) {
  return sovfhubPost<RegisterRecord>('register_unlock', { companion_number: companionNumber, pin });
}

// --- Not yet built on SovfHub; contract only, calling these will throw ---

export interface PropertyRecord {
  id: string;
  description: string;
  ownerCompanionNumber: string;
  registeredDate: string;
  status: 'registered' | 'transferred' | 'revoked';
}

export async function getPropertyRecord(_id: string): Promise<PropertyRecord> {
  throw new Error('Property API is not built on SovfHub yet');
}

export async function searchProperty(_query: string): Promise<PropertyRecord[]> {
  throw new Error('Property API is not built on SovfHub yet');
}

// Companion Portal sign-in is handled via SSO (see ../lib/sso.ts), not this
// file — SovfHub's own account system is the identity provider.

export interface PublicNotice {
  id: number;
  title: string;
  content: string;
  status: 'draft' | 'published';
  authorName: string;
  authorCompanionNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

// Read endpoints are unauthenticated on SovfHub — the content is public by
// design, so the API_KEY sent here is harmless but not required.
export function listPublicNotices(page = 1) {
  return sovfhubGet<{ notices: PublicNotice[]; page: number }>('notices_list', { page: String(page) });
}

export function getPublicNotice(id: number) {
  return sovfhubGet<{ notice: PublicNotice }>('notices_get', { id: String(id) });
}

// Mutations require the companion's own SSO access token.
export function getMyNotices(accessToken: string) {
  return sovfhubUserGet<{ notices: PublicNotice[] }>('notices_mine', accessToken);
}

export function createNotice(accessToken: string, title: string, content: string, status: 'draft' | 'published' = 'published') {
  return sovfhubUserPost<{ id: number }>('notices_create', accessToken, { title, content, status });
}

export function updateNotice(accessToken: string, id: number, title: string, content: string, status: 'draft' | 'published' = 'published') {
  return sovfhubUserPost<Record<string, never>>('notices_update', accessToken, { id: String(id), title, content, status });
}

export function deleteNotice(accessToken: string, id: number) {
  return sovfhubUserPost<Record<string, never>>('notices_delete', accessToken, { id: String(id) });
}
