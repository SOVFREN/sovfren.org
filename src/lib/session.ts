// Shared Companion Portal session handling — reads/refreshes/writes the
// sovfren_session cookie. Factored out once portal/notices/* needed the
// same logic already used by portal/index.astro and portal/callback.astro.

import type { AstroGlobal } from 'astro';
import { fetchUserInfo, refreshTokens } from './sso';

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const COOKIE_NAME = 'sovfren_session';

/**
 * True if this request reached us over HTTPS — either directly, or via a
 * reverse proxy that terminates TLS and forwards X-Forwarded-Proto.
 * @astrojs/node's standalone server doesn't trust that header itself, so
 * Astro.url.protocol alone is always "http:" behind nginx even when the
 * public-facing connection is HTTPS — checking it in isolation would mean
 * Secure cookies never get set once this is deployed behind the reverse
 * proxy (sovfren.org's production setup), same failure mode as the
 * plain-HTTP-test-server bug this check originally existed to avoid.
 */
export function isSecureRequest(Astro: AstroGlobal): boolean {
  return Astro.url.protocol === 'https:' || Astro.request.headers.get('x-forwarded-proto') === 'https';
}

export function setSession(Astro: AstroGlobal, session: Session): void {
  Astro.cookies.set(COOKIE_NAME, JSON.stringify(session), {
    httpOnly: true,
    secure: isSecureRequest(Astro),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSession(Astro: AstroGlobal): void {
  Astro.cookies.delete(COOKIE_NAME, { path: '/' });
}

/**
 * Reads the session cookie, transparently refreshing the access token if
 * it's about to expire. Returns null (and clears the cookie) if there's no
 * session, it's malformed, or the refresh fails — callers should redirect
 * to /portal/login in that case.
 *
 * Also rechecks Companion Portal access (sovfren_org_access, see sso.ts)
 * on every refresh — roughly hourly, matching the access token lifetime —
 * so a permission revoked on the SovfHub side takes effect without
 * waiting for the full 30-day refresh-token/session lifetime to elapse.
 * portal/callback.astro performs the same check at initial login, so a
 * session is never created without access in the first place.
 */
export async function getSession(Astro: AstroGlobal): Promise<Session | null> {
  const raw = Astro.cookies.get(COOKIE_NAME)?.value;
  if (!raw) {
    return null;
  }

  let session: Session;
  try {
    session = JSON.parse(raw);
  } catch {
    clearSession(Astro);
    return null;
  }

  if (session.expiresAt < Date.now() + 30_000) {
    try {
      const tokens = await refreshTokens(session.refreshToken);
      const profile = await fetchUserInfo(tokens.access_token);
      if (!profile.sovfren_org_access) {
        clearSession(Astro);
        return null;
      }
      session = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      };
      setSession(Astro, session);
    } catch {
      clearSession(Astro);
      return null;
    }
  }

  return session;
}
