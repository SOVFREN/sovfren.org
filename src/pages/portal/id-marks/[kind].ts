export const prerender = false;

import type { APIRoute } from 'astro';
import { fetchUserInfo } from '../../../lib/sso';
import { getSession } from '../../../lib/session';
import { MARK_KINDS, readMark, type MarkKind } from '../../../lib/idmarks';

// Serves the signed-in Companion's own thumbprint/autograph image, never anyone else's.
export const GET: APIRoute = async (Astro) => {
  const kind = Astro.params.kind as MarkKind;
  const session = await getSession(Astro);
  if (!session || !MARK_KINDS.includes(kind)) return new Response('Not found', { status: 404 });

  let companionNumber: string | undefined;
  try {
    companionNumber = (await fetchUserInfo(session.accessToken)).companion_number;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const mark = companionNumber ? await readMark(companionNumber, kind) : null;
  if (!mark) return new Response('Not found', { status: 404 });

  return new Response(mark.bytes, {
    headers: { 'Content-Type': mark.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
};
