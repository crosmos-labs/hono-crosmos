import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { KeyLike } from 'jose';
import type { Env } from '../src/bindings';
import { app } from '../src/index';

const originalFetch = globalThis.fetch;
let privateKey: KeyLike;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

const limiter = {
  idFromName() { return {} as DurableObjectId; },
  get() {
    return { fetch: async () => Response.json({ allowed: true }) };
  },
} as unknown as DurableObjectNamespace;

const env = {
  ADMIN_RATE_LIMITER: limiter,
  ENVIRONMENT: 'development',
  ACCESS_TEAM_DOMAIN: 'admin-test.example',
  ACCESS_AUD: 'admin-audience',
  ADMIN_ALLOWED_EMAILS: 'operator@example.com',
} as unknown as Env;

async function token(input: { email?: string; audience?: string; expiresIn?: string } = {}) {
  return new SignJWT({ email: input.email ?? 'operator@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://admin-test.example')
    .setAudience(input.audience ?? 'admin-audience')
    .setIssuedAt()
    .setExpirationTime(input.expiresIn ?? '5m')
    .sign(privateKey);
}

async function protectedRequest(accessToken?: string, authorization?: string) {
  const headers = new Headers();
  if (accessToken) headers.set('Cf-Access-Jwt-Assertion', accessToken);
  if (authorization) headers.set('Authorization', authorization);
  return app.request('/admin/whoami', { headers }, env);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'test-key';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'https://admin-test.example/cdn-cgi/access/certs') {
      return Response.json({ keys: [publicJwk] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => { globalThis.fetch = originalFetch; });

describe('admin authentication gates', () => {
  test('rejects missing Access JWT even with a Crosmos API key', async () => {
    expect((await protectedRequest(undefined, 'Bearer csk_owner')).status).toBe(403);
  });

  test('rejects a valid Access JWT for a non-allowlisted email', async () => {
    expect((await protectedRequest(await token({ email: 'other@example.com' }))).status).toBe(403);
  });

  test('rejects expired and wrong-audience Access JWTs', async () => {
    expect((await protectedRequest(await token({ expiresIn: '-1s' }))).status).toBe(403);
    expect((await protectedRequest(await token({ audience: 'other-audience' }))).status).toBe(403);
  });

  test('accepts only the JWT plus external email allowlist combination', async () => {
    const response = await protectedRequest(await token());
    expect(response.status).toBe(200);
    expect(await response.json() as { email: string }).toEqual({ email: 'operator@example.com' });
  });
});
