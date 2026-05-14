import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CERTS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const SCOPES = 'openid email profile';
const ALLOWED_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Module-scoped JWKS — jose caches keys with 10-minute TTL and refreshes on kid miss.
const GOOGLE_JWKS = createRemoteJWKSet(GOOGLE_CERTS_URL);

export interface OAuthUserInfo {
  provider: 'google';
  providerUserId: string;
  email: string;
  name: string;
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function buildGoogleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state: input.state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<OAuthUserInfo> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new OAuthError(`Google token exchange failed (${tokenRes.status}): ${text}`);
  }

  const tokenData = (await tokenRes.json()) as { id_token?: string };
  if (!tokenData.id_token) {
    throw new OAuthError('No id_token in Google token response');
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokenData.id_token, GOOGLE_JWKS, {
      algorithms: ['RS256'],
      audience: input.clientId,
      issuer: ALLOWED_ISSUERS,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    throw new OAuthError(
      `Invalid Google ID token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : '';
  if (!sub || !email) {
    throw new OAuthError('Google ID token missing sub or email');
  }
  const name =
    (typeof payload.name === 'string' && payload.name) ||
    email.split('@')[0] ||
    email;

  return {
    provider: 'google',
    providerUserId: sub,
    email,
    name,
  };
}
