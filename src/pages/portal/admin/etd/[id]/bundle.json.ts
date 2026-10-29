export const prerender = false;

import type { APIRoute, AstroGlobal } from 'astro';
import { requireAdmin } from '../../../../../lib/admin';
import { exportBundle, getInstrument } from '../../../../../lib/etd';

// Self-contained, offline-verifiable copy of an instrument (terms, signed
// event chain, public keys). A copy proves nothing about who currently holds
// the instrument: only the registry's live chain does.
export const GET: APIRoute = async (Astro) => {
  const gate = await requireAdmin(Astro as unknown as AstroGlobal);
  if (gate instanceof Response) return new Response('Not found', { status: 404 });
  const inst = await getInstrument(Astro.params.id ?? '');
  if (!inst) return new Response('Not found', { status: 404 });
  return new Response(JSON.stringify(await exportBundle(inst), null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${inst.terms.serial}.etd.json"`,
      'Cache-Control': 'no-store',
    },
  });
};
