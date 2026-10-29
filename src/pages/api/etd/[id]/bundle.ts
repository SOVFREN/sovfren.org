export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticate } from '../../../../lib/etd-apikeys';
import { exportBundle, getInstrument } from '../../../../lib/etd';

// The signed, offline-verifiable bundle for a keyed counterparty. A copy of the
// bundle never proves current ownership: use /api/etd/<id> for live status.
export const GET: APIRoute = async (Astro) => {
  let client = 'unknown';
  try {
    client = Astro.clientAddress;
  } catch {
    // adapter could not determine an address
  }
  const auth = await authenticate(Astro.request.headers.get('authorization'), client);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) },
    });
  if (!auth.ok) return json(auth.status, { error: auth.status === 429 ? 'Too many attempts' : 'Unauthorized' });
  const inst = await getInstrument(Astro.params.id ?? '');
  if (!inst) return json(404, { error: 'Not found' });
  return json(200, await exportBundle(inst));
};
