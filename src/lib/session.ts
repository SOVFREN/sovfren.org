// Shared Companion Portal session handling — reads/refreshes/writes the
// sovfren_session cookie. Factored out once portal/notices/* needed the
// same logic already used by portal/index.astro and portal/callback.astro.

import type { AstroGlobal } from 'astro';
import { refreshTokens } from './sso';

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const COOKIE_NAME = 'sovfren_session';

export function setSession(Astro: AstroGlobal, session: Session): void {
  Astro.cookies.set(COOKIE_NAME, JSON.stringify(session), {
    httpOnly: true,
    secure: Astro.url.protocol === 'https:',
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
