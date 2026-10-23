export const prerender = false;

import type { APIRoute, AstroGlobal } from 'astro';
import { fetchUserInfo } from '../../../lib/sso';
import { getSession } from '../../../lib/session';
import { isAdminCompanion } from '../../../lib/admin';
import { DOCUMENT_KINDS, MARK_KINDS, readMark, type MarkKind } from '../../../lib/idmarks';

// Serves the signed-in Companion's own autograph/seal/heraldry image. Admins may
// also pass ?c=<CompanionNumber> to review an applicant's images.
export const GET: APIRoute = async (Astro) => {
  const kind = Astro.params.kind as MarkKind;
  const session = await getSession(Astro as unknown as AstroGlobal);
  if (!session || !MARK_KINDS.includes(kind)) return new Response('Not found', { status: 404 });

  let companionNumber: string | undefined;
  try {
    companionNumber = (await fetchUserInfo(session.accessToken)).companion_number;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const requested = Astro.url.searchParams.get('c');
  if (requested && requested !== companionNumber) {
    if (!isAdminCompanion(companionNumber)) return new Response('Not found', { status: 404 });
    companionNumber = requested;
  }
  const mark = companionNumber ? await readMark(companionNumber, kind) : null;
  if (!mark) return new Response('Not found', { status: 404 });

  const headers: Record<string, string> = {
    'Content-Type': mark.type,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // Documents are user-supplied: always download them, never render them in-page.
  if (DOCUMENT_KINDS.includes(kind)) {
    const ext = mark.type === 'application/pdf' ? 'pdf' : mark.type.split('/')[1];
    headers['Content-Disposition'] = `attachment; filename="${kind}-${companionNumber}.${ext}"`;
  }
  return new Response(new Uint8Array(mark.bytes), { headers });
};
