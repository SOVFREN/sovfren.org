// OAuth2 + PKCE client for SovfHub's SSO provider (sso.sovfhub.com).
// Sovfren.org is registered there as a confidential client ("Sovfren.org")
// in sso_clients. This is the same authorization-code flow SovfHub's own
// sibling apps (SovfWin, SovfIO, ...) use to sign in with a SovfHub account.

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export async function generatePkce(): Promise<Pkce> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: import.meta.env.SSO_CLIENT_ID,
    redirect_uri: import.meta.env.SSO_REDIRECT_URI,
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${import.meta.env.SSO_AUTHORIZE_URL}?${params}`;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(import.meta.env.SSO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${import.meta.env.SSO_CLIENT_ID}:${import.meta.env.SSO_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    throw new Error(`SSO token request failed: ${res.status}`);
  }
  return res.json() as Promise<TokenSet>;
}

export function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: import.meta.env.SSO_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
}

export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

export interface SsoProfile {
  sub: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  companion_number?: string;
  email?: string;
  email_verified?: boolean;
  // Whether SovfHub has granted this account access to the Companion
  // Portal / future internal area — see sovfren_permissions on the
  // SovfHub side (VPS-NOTES.md §4). Absent access denies the portal;
  // staff is a superset reserved for the future internal management area.
  sovfren_org_access?: boolean;
  sovfren_org_staff?: boolean;
}

export async function fetchUserInfo(accessToken: string): Promise<SsoProfile> {
  const res = await fetch(import.meta.env.SSO_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`SSO userinfo request failed: ${res.status}`);
  }
  return res.json() as Promise<SsoProfile>;
}
