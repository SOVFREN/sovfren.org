export const prerender = false;

import type { APIRoute, AstroGlobal } from 'astro';
import { requireAdmin } from '../../../../../lib/admin';
import { exportStandard, getInstrument } from '../../../../../lib/etd';

// Live, machine-readable status and terms (identifiers, parties, holder,
// verification result). Admin-only for now; a keyed API for custodians and
// counterparties can sit on the same function later.
export const GET: APIRoute = async (Astro) => {
  const gate = await requireAdmin(Astro as unknown as AstroGlobal);
  if (gate instanceof Response) return new Response('Not found', { status: 404 });
  const inst = await getInstrument(Astro.params.id ?? '');
  if (!inst) return new Response('Not found', { status: 404 });
  const base = new URL(Astro.site ?? Astro.url.origin).origin;
  return new Response(JSON.stringify(await exportStandard(inst, base), null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
