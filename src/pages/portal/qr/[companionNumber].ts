export const prerender = false;

import type { APIRoute, AstroGlobal } from 'astro';
import QRCode from 'qrcode';
import { fetchUserInfo } from '../../../lib/sso';
import { getSession } from '../../../lib/session';
import { isAdminCompanion } from '../../../lib/admin';

// Downloadable QR code for a Companion's Register record, to print on their
// Declaration of Life so the document and the ID share one code. The Companion
// can download their own; admins can download anyone's. ?format=svg for vector.
export const GET: APIRoute = async (Astro) => {
  const requested = Astro.params.companionNumber ?? '';
  const session = await getSession(Astro as unknown as AstroGlobal);
  if (!session || !/^[A-Za-z0-9]+$/.test(requested)) return new Response('Not found', { status: 404 });

  let ownNumber: string | undefined;
  try {
    ownNumber = (await fetchUserInfo(session.accessToken)).companion_number;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (requested !== ownNumber && !isAdminCompanion(ownNumber)) return new Response('Not found', { status: 404 });

  const url = new URL(`/register/${requested}`, Astro.site ?? Astro.url.origin).href;
  const options = { errorCorrectionLevel: 'H' as const, margin: 4 };

  if (Astro.url.searchParams.get('format') === 'svg') {
    const svg = await QRCode.toString(url, { ...options, type: 'svg' });
    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Content-Disposition': `attachment; filename="qr-${requested}.svg"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const png = await QRCode.toBuffer(url, { ...options, type: 'png', width: 1200 });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="qr-${requested}.png"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
