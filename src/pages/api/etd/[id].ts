export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticate } from '../../../lib/etd-apikeys';
import { exportStandard, getInstrument } from '../../../lib/etd';

// Read-only status of one instrument for counterparties and custodians.
//   GET /api/etd/<instrument id>   Authorization: Bearer etdk_...
// Returns the live registry state, identifiers, holder and verification result.
// Unknown ids and bad keys are answered the same way as far as possible.
export const GET: APIRoute = async (Astro) => {
  let client = 'unknown';
  try {
    client = Astro.clientAddress;
  } catch {
    // adapter could not determine an address
  }
  const auth = await authenticate(Astro.request.headers.get('authorization'), client);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.status === 429 ? 'Too many attempts' : 'Unauthorized' }), {
      status: auth.status,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' },
    });
  }
  const inst = await getInstrument(Astro.params.id ?? '');
  if (!inst) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const base = new URL(Astro.site ?? Astro.url.origin).origin;
  const body = await exportStandard(inst, base);
  // Counterparties get the API link to the signed bundle, not the admin one.
  body.proof.bundle = `${base}/api/etd/${inst.id}/bundle`;
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
