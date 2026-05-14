import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { tokenUrlSafe } from './random.js';

export const JWT_ALG = 'HS256';
export const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export type TokenType = 'access' | 'refresh';

export interface AccessTokenPayload {
  sub: string;
  type: 'access';
  iat: number;
  exp: number;
  active_org_id?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  iat: number;
  exp: number;
  jti: string;
}

export interface AccessTokenClaims {
  userId: number;
  activeOrgId: number | null;
  expiresAt: Date;
}

export interface RefreshTokenClaims {
  userId: number;
  jti: string;
  expiresAt: Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshJti: string;
  refreshExpiresAt: Date;
}

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

export async function createAccessToken(
  jwtSecret: string,
  userId: number,
  options: { activeOrgId?: number | null; ttlSeconds?: number } = {},
): Promise<string> {
  const ttl = options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const iat = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {
    sub: String(userId),
    type: 'access',
  };
  if (options.activeOrgId != null) {
    payload.active_org_id = options.activeOrgId;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(secretKey(jwtSecret));
}

export async function createRefreshToken(
  jwtSecret: string,
  userId: number,
  options: { ttlSeconds?: number; jti?: string } = {},
): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const ttl = options.ttlSeconds ?? REFRESH_TOKEN_TTL_SECONDS;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  const jti = options.jti ?? tokenUrlSafe(16);

  const token = await new SignJWT({
    sub: String(userId),
    type: 'refresh',
    jti,
  })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(secretKey(jwtSecret));

  return { token, jti, expiresAt: new Date(exp * 1000) };
}

export async function createTokenPair(
  jwtSecret: string,
  userId: number,
  options: { activeOrgId?: number | null } = {},
): Promise<TokenPair> {
  const accessToken = await createAccessToken(jwtSecret, userId, {
    activeOrgId: options.activeOrgId,
  });
  const refresh = await createRefreshToken(jwtSecret, userId);
  return {
    accessToken,
    refreshToken: refresh.token,
    refreshJti: refresh.jti,
    refreshExpiresAt: refresh.expiresAt,
  };
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

async function verify<T>(jwtSecret: string, token: string): Promise<T> {
  try {
    const { payload } = await jwtVerify(token, secretKey(jwtSecret), {
      algorithms: [JWT_ALG],
    });
    return payload as T;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new InvalidTokenError('Token expired');
    }
    throw new InvalidTokenError('Invalid token');
  }
}

export async function decodeAccessTokenClaims(
  jwtSecret: string,
  token: string,
): Promise<AccessTokenClaims> {
  const payload = await verify<AccessTokenPayload>(jwtSecret, token);
  if (payload.type !== 'access') {
    throw new InvalidTokenError('Not an access token');
  }
  const userId = Number(payload.sub);
  if (!Number.isFinite(userId)) {
    throw new InvalidTokenError('Invalid subject');
  }
  return {
    userId,
    activeOrgId:
      typeof payload.active_org_id === 'number' ? payload.active_org_id : null,
    expiresAt: new Date(payload.exp * 1000),
  };
}

export async function decodeRefreshTokenClaims(
  jwtSecret: string,
  token: string,
): Promise<RefreshTokenClaims> {
  const payload = await verify<RefreshTokenPayload>(jwtSecret, token);
  if (payload.type !== 'refresh') {
    throw new InvalidTokenError('Not a refresh token');
  }
  if (!payload.jti) {
    throw new InvalidTokenError('Missing jti');
  }
  const userId = Number(payload.sub);
  if (!Number.isFinite(userId)) {
    throw new InvalidTokenError('Invalid subject');
  }
  return {
    userId,
    jti: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

// Sign/verify a generic short-lived JWT for OAuth flow state (CSRF protection).
export async function signFlowState(
  jwtSecret: string,
  claims: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(secretKey(jwtSecret));
}

export async function verifyFlowState<T = Record<string, unknown>>(
  jwtSecret: string,
  token: string,
): Promise<T> {
  return verify<T>(jwtSecret, token);
}
