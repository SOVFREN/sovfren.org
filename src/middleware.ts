import { defineMiddleware } from 'astro:middleware';
import type { AstroGlobal } from 'astro';
import { fetchUserInfo } from './lib/sso';
import { getSession, clearSession } from './lib/session';
import { isAdminCompanion } from './lib/admin';

// The Companion Portal is restricted to admins for now. Every /portal request
// from a signed-in session is checked here, so no other Companion can reach
// any portal page or file even if they already hold a valid session.
// (Sign-in itself is also refused for non-admins in portal/callback.astro.)
const OPEN_PATHS = new Set(['/portal/login', '/portal/callback', '/portal/logout']);

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname.replace(/\/+$/, '');
  if (!(path === '/portal' || path.startsWith('/portal/')) || OPEN_PATHS.has(path)) {
    return next();
  }

  const global = context as unknown as AstroGlobal;
  const session = await getSession(global);
  if (!session) return next(); // pages redirect signed-out visitors to /portal/login

  try {
    const profile = await fetchUserInfo(session.accessToken);
    if (isAdminCompanion(profile.companion_number)) return next();
  } catch {
    // fall through: treat an unverifiable session as not allowed
  }

  clearSession(global);
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Companion Portal</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#0f172a">' +
      '<h1 style="font-size:1.4rem">The Companion Portal is currently closed</h1>' +
      '<p style="color:#5f728c">Access is restricted at the moment. <a href="/">Return to the Sovfren Society home page</a>.</p>',
    { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
});
