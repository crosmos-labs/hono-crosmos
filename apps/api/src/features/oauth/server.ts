import {
  ACCESS_TOKEN_TTL_SECONDS,
  createTokenPair,
  decodeRefreshTokenClaims,
  InvalidTokenError,
  signFlowState,
  verifyFlowState,
} from '../auth/jwt';
import { sha256Base64Url, sha256Hex, tokenUrlSafe } from '../../lib/crypto';
import {
  authorizationCodes,
  oauthClients,
  type AuthorizationCode,
  type OAuthClient,
} from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { and, eq } from 'drizzle-orm';
import { getEarliestMembershipForUser } from '../orgs/memberships';
import { isRefreshTokenRevoked } from '../auth/refresh-tokens';
import { getUserById } from '../auth/users';

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const FLOW_STATE_TTL_SECONDS = 10 * 60; // 10 minutes

export class OAuthServerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthServerError';
  }
}

// ── Client registration ────────────────────────────────────────────────

export async function hashClientSecret(raw: string): Promise<string> {
  return sha256Hex(raw);
}

export async function registerClient(
  db: Database,
  input: {
    redirectUris: string[];
    clientName?: string | null;
    grantTypes?: string[] | null;
    responseTypes?: string[] | null;
    tokenEndpointAuthMethod?: string;
  },
): Promise<{ client: OAuthClient; rawSecret: string | null }> {
  const clientId = tokenUrlSafe(24);
  const tokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? 'none';

  let rawSecret: string | null = null;
  let secretHash: string | null = null;
  if (tokenEndpointAuthMethod !== 'none') {
    rawSecret = tokenUrlSafe(32);
    secretHash = await hashClientSecret(rawSecret);
  }

  const [row] = await db
    .insert(oauthClients)
    .values({
      clientId,
      clientSecretHash: secretHash,
      redirectUris: input.redirectUris,
      clientName: input.clientName ?? null,
      grantTypes: input.grantTypes ?? ['authorization_code', 'refresh_token'],
      responseTypes: input.responseTypes ?? ['code'],
      tokenEndpointAuthMethod,
    })
    .returning();
  if (!row) throw new Error('Failed to register client');
  return { client: row, rawSecret };
}

export async function getClient(
  db: Database,
  clientId: string,
): Promise<OAuthClient | null> {
  const rows = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

// ── Flow state ─────────────────────────────────────────────────────────

export interface FlowStateClaims {
  v: 1;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string | null;
  scope?: string | null;
}

export async function createFlowState(
  jwtSecret: string,
  claims: FlowStateClaims,
): Promise<string> {
  return signFlowState(
    jwtSecret,
    claims as unknown as Record<string, unknown>,
    FLOW_STATE_TTL_SECONDS,
  );
}

export async function decodeFlowState(
  jwtSecret: string,
  token: string,
): Promise<FlowStateClaims> {
  return verifyFlowState<FlowStateClaims>(jwtSecret, token);
}

// ── Authorization code ─────────────────────────────────────────────────

export async function createAuthorizationCode(
  db: Database,
  input: {
    clientId: string;
    userId: number;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope?: string | null;
  },
): Promise<string> {
  const code = tokenUrlSafe(32);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS);
  await db.insert(authorizationCodes).values({
    code,
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope ?? null,
    expiresAt,
    used: false,
  });
  return code;
}

/**
 * Verify a PKCE `code_verifier` against the stored `code_challenge`. Supports
 * `S256` (required by our metadata) and `plain`. Throws `invalid_grant` if the
 * verifier is missing or doesn't match. Constant-timeyness isn't required: the
 * challenge is single-use and high-entropy, and we compare derived digests.
 */
async function verifyPkce(
  authCode: AuthorizationCode,
  codeVerifier: string | null | undefined,
): Promise<void> {
  const challenge = authCode.codeChallenge;
  if (!challenge) {
    // Every authorize flow stores a challenge; absence means a malformed/legacy
    // code. Refuse rather than silently skip PKCE.
    throw new OAuthServerError('invalid_grant', 'Missing PKCE challenge on authorization code');
  }
  if (!codeVerifier) {
    throw new OAuthServerError('invalid_request', 'Missing code_verifier');
  }
  const method = (authCode.codeChallengeMethod || 'S256').toUpperCase();
  let derived: string;
  if (method === 'S256') {
    derived = await sha256Base64Url(codeVerifier);
  } else if (method === 'PLAIN') {
    derived = codeVerifier;
  } else {
    throw new OAuthServerError('invalid_request', `Unsupported code_challenge_method: ${method}`);
  }
  if (derived !== challenge) {
    throw new OAuthServerError('invalid_grant', 'PKCE verification failed');
  }
}

async function markCodeUsed(db: Database, code: string): Promise<AuthorizationCode | null> {
  const [row] = await db
    .update(authorizationCodes)
    .set({ used: true })
    .where(and(eq(authorizationCodes.code, code), eq(authorizationCodes.used, false)))
    .returning();
  return row ?? null;
}

async function resolveActiveOrgId(
  db: Database,
  userId: number,
): Promise<number | null> {
  const membership = await getEarliestMembershipForUser(db, userId);
  return membership?.orgId ?? null;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  refresh_token: string;
}

export async function exchangeAuthorizationCode(
  db: Database,
  jwtSecret: string,
  input: {
    code: string;
    clientId: string;
    redirectUri?: string | null;
    codeVerifier?: string | null;
  },
): Promise<OAuthTokenResponse> {
  const rows = await db
    .select()
    .from(authorizationCodes)
    .where(eq(authorizationCodes.code, input.code))
    .limit(1);
  const authCode = rows[0];
  if (!authCode) throw new OAuthServerError('invalid_grant', 'Invalid authorization code');
  if (authCode.used) throw new OAuthServerError('invalid_grant', 'Authorization code already used');
  if (authCode.clientId !== input.clientId) {
    throw new OAuthServerError('invalid_grant', 'Client ID mismatch');
  }
  if (authCode.expiresAt.getTime() < Date.now()) {
    throw new OAuthServerError('invalid_grant', 'Authorization code expired');
  }
  if (input.redirectUri && authCode.redirectUri !== input.redirectUri) {
    throw new OAuthServerError('invalid_grant', 'Redirect URI mismatch');
  }

  // PKCE verification (RFC 7636). All our clients are public
  // (`token_endpoint_auth_method: none`), so the code is otherwise a pure
  // bearer credential — an intercepted code could be redeemed by anyone.
  // Verifying `code_verifier` against the stored `code_challenge` binds the
  // redemption to the party that began the flow. This is done BEFORE marking
  // the code used so a failed verification doesn't burn a legitimate code.
  await verifyPkce(authCode, input.codeVerifier);

  const marked = await markCodeUsed(db, authCode.code);
  if (!marked) {
    // Race lost — another request grabbed it first.
    throw new OAuthServerError('invalid_grant', 'Authorization code already used');
  }

  const activeOrgId = await resolveActiveOrgId(db, authCode.userId);
  const pair = await createTokenPair(jwtSecret, authCode.userId, { activeOrgId });

  return {
    access_token: pair.accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: pair.refreshToken,
  };
}

export async function exchangeRefreshTokenOauth(
  db: Database,
  jwtSecret: string,
  input: { refreshToken: string; clientId: string },
): Promise<OAuthTokenResponse> {
  let claims;
  try {
    claims = await decodeRefreshTokenClaims(jwtSecret, input.refreshToken);
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      throw new OAuthServerError('invalid_grant', err.message);
    }
    throw err;
  }
  if (await isRefreshTokenRevoked(db, claims.jti)) {
    throw new OAuthServerError('invalid_grant', 'Refresh token has been revoked');
  }
  const user = await getUserById(db, claims.userId);
  if (!user || !user.isActive) {
    throw new OAuthServerError('invalid_grant', 'User account is inactive or not found');
  }
  const client = await getClient(db, input.clientId);
  if (!client) {
    throw new OAuthServerError('invalid_grant', 'Unknown client');
  }
  const activeOrgId = await resolveActiveOrgId(db, user.id);
  const pair = await createTokenPair(jwtSecret, user.id, { activeOrgId });

  return {
    access_token: pair.accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: pair.refreshToken,
  };
}
