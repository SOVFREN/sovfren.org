// Admin gate shared by the portal pages: Companion Numbers listed in
// ADMIN_COMPANION_NUMBERS (comma-separated; defaults to the Principal's).
export function isAdminCompanion(companionNumber?: string | null): boolean {
  if (!companionNumber) return false;
  const admins = (import.meta.env.ADMIN_COMPANION_NUMBERS ?? 'SovfCom00000001')
    .split(',')
    .map((n: string) => n.trim());
  return admins.includes(companionNumber);
}

import type { AstroGlobal } from 'astro';
import { fetchUserInfo, type SsoProfile } from './sso';
import { getSession, clearSession } from './session';

/**
 * Gate for admin pages: returns the admin's profile, or a Response to return
 * as-is (redirect to login when signed out, plain 404 when not an admin).
 */
export async function requireAdmin(Astro: AstroGlobal): Promise<{ profile: SsoProfile } | Response> {
  const session = await getSession(Astro);
  if (!session) return Astro.redirect('/portal/login');
  let profile: SsoProfile;
  try {
    profile = await fetchUserInfo(session.accessToken);
  } catch {
    clearSession(Astro);
    return Astro.redirect('/portal/login');
  }
  if (!isAdminCompanion(profile.companion_number)) return new Response('Not found', { status: 404 });
  return { profile };
}
