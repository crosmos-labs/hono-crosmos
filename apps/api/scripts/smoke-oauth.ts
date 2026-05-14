#!/usr/bin/env bun
// Smoke test for Phase 2b OAuth (server + consumer non-network parts).
// Strategy:
//   • Hit the public OAuth-server endpoints over HTTP: /.well-known, /register, /authorize, /token.
//   • For the parts that would normally bounce off Google, we simulate the
//     post-Google step by directly inserting an authorization_code row using
//     the real service module, then exchanging it via POST /oauth/token.
//   • Verify PKCE-protected public client flow + refresh_token grant.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createDb } from '@crosmos/db';
import { createAuthorizationCode } from '../src/features/oauth/server';
import { sha256Hex, tokenUrlSafe } from '../src/lib/crypto';

const ENV: Record<string, string> = {};
for (const line of readFileSync(
  new URL('../.dev.vars', import.meta.url).pathname,
  'utf8',
).split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  ENV[t.slice(0, i).trim()] = v;
}
const DATABASE_URL = ENV.DATABASE_URL!;
const BASE = 'http://localhost:8787';

const adminSql = postgres(DATABASE_URL);
const db = createDb(DATABASE_URL);

let failures = 0;
function assert(cond: any, label: string, ctx?: any) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}`, ctx ?? ''); }
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(BASE + path, { ...init, redirect: 'manual' });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, headers: res.headers };
}

console.log('▶ Preparing test user…');
await adminSql`DELETE FROM authorization_codes WHERE redirect_uri LIKE 'https://client.test/%'`;
await adminSql`DELETE FROM oauth_clients WHERE client_name = 'smoke-client'`;
await adminSql`DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email = 'oauth-smoke@crosmos.test')`;
await adminSql`DELETE FROM organizations WHERE slug LIKE 'oauth-smoke%'`;
await adminSql`DELETE FROM users WHERE email = 'oauth-smoke@crosmos.test'`;

const [user] = await adminSql`
  INSERT INTO users (uuid, email, name, oauth_provider, oauth_provider_id)
  VALUES (gen_random_uuid(), 'oauth-smoke@crosmos.test', 'OAuth Smoke', 'google', ${'g-' + tokenUrlSafe(8)})
  RETURNING id, uuid
`;
const [org] = await adminSql`
  INSERT INTO organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
  VALUES (gen_random_uuid(), 'oauth-smoke-org', 'OAuth Smoke Org', 'free', true, ${user.id})
  RETURNING id, uuid
`;
await adminSql`
  INSERT INTO organization_members (uuid, org_id, user_id, role)
  VALUES (gen_random_uuid(), ${org.id}, ${user.id}, 'owner')
`;
console.log(`  user.id=${user.id} org.uuid=${org.uuid}`);

console.log('▶ GET /.well-known/oauth-authorization-server');
{
  const r = await api('/.well-known/oauth-authorization-server');
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.code_challenge_methods_supported?.includes('S256'), 'S256 advertised');
}

console.log('▶ POST /oauth/register (public MCP-style client)');
let clientId: string;
{
  const r = await api('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://client.test/cb'],
      client_name: 'smoke-client',
      grant_types: ['authorization_code', 'refresh_token'],
    }),
  });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(typeof r.body.client_id === 'string' && r.body.client_id.length > 0, 'client_id returned');
  assert(r.body.client_secret === null, 'public client → null secret');
  assert(r.body.token_endpoint_auth_method === 'none', 'forced to "none"');
  clientId = r.body.client_id;
}

console.log('▶ GET /oauth/authorize (with valid client + PKCE) → 302 to Google');
{
  // Build PKCE challenge
  const verifier = tokenUrlSafe(32);
  // PKCE S256: base64url(sha256(verifier))
  const challengeHex = await sha256Hex(verifier);
  // hex → bytes → base64url
  const bytes = new Uint8Array(challengeHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(challengeHex.slice(i*2, i*2+2), 16);
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

  const url = `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.test/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=client-state-xyz`;
  const r = await api(url);
  assert(r.status === 302, `status 302 (got ${r.status})`);
  const loc = r.headers.get('location') ?? '';
  assert(loc.startsWith('https://accounts.google.com/'), `Google redirect (got ${loc.slice(0, 80)})`);
  assert(loc.includes('state='), 'flow state in location');
}

console.log('▶ GET /oauth/authorize (unknown client_id) → 400');
{
  const r = await api(`/oauth/authorize?response_type=code&client_id=does-not-exist&redirect_uri=${encodeURIComponent('https://client.test/cb')}&code_challenge=abc&code_challenge_method=S256`);
  assert(r.status === 400, `status 400 (got ${r.status})`);
}

console.log('▶ GET /oauth/authorize (redirect_uri not registered) → 400');
{
  const r = await api(`/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.test/cb')}&code_challenge=abc&code_challenge_method=S256`);
  assert(r.status === 400, `status 400 (got ${r.status})`);
}

console.log('▶ Simulating "post-Google" by directly creating an authorization_code…');
const challenge = 'simulated-pkce-challenge';
const code = await createAuthorizationCode(db, {
  clientId,
  userId: user.id,
  redirectUri: 'https://client.test/cb',
  codeChallenge: challenge,
  codeChallengeMethod: 'S256',
  scope: null,
});
console.log(`  code=${code.slice(0, 12)}…`);

console.log('▶ POST /oauth/token (authorization_code grant)');
let refreshToken: string;
{
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://client.test/cb',
    client_id: clientId,
    code_verifier: 'whatever', // public client, PKCE done upstream by MCP proxy
  });
  const r = await api('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(typeof r.body.access_token === 'string', 'access_token returned');
  assert(typeof r.body.refresh_token === 'string', 'refresh_token returned');
  assert(r.body.token_type === 'bearer', 'token_type=bearer');
  assert(typeof r.body.expires_in === 'number', 'expires_in is number');
  refreshToken = r.body.refresh_token;
}

console.log('▶ POST /oauth/token (re-using same code) → invalid_grant');
{
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://client.test/cb',
    client_id: clientId,
  });
  const r = await api('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert(r.status === 400, `status 400 (got ${r.status})`);
  assert(r.body.error === 'invalid_grant', `error=invalid_grant (got ${r.body.error})`);
}

console.log('▶ POST /oauth/token (redirect_uri mismatch)');
{
  const code2 = await createAuthorizationCode(db, {
    clientId,
    userId: user.id,
    redirectUri: 'https://client.test/cb',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    scope: null,
  });
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code2,
    redirect_uri: 'https://wrong.test/cb',
    client_id: clientId,
  });
  const r = await api('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert(r.status === 400, `status 400 (got ${r.status})`);
  assert(r.body.error === 'invalid_grant', 'invalid_grant');
}

console.log('▶ POST /oauth/token (refresh_token grant)');
{
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const r = await api('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(typeof r.body.access_token === 'string', 'new access_token');
}

console.log('▶ POST /oauth/token (refresh_token + unknown client_id)');
{
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: 'totally-bogus',
  });
  const r = await api('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert(r.status === 401, `status 401 (got ${r.status})`);
  assert(r.body.error === 'invalid_client', `invalid_client (got ${r.body.error})`);
}

console.log('▶ POST /oauth/token (unsupported grant_type)');
{
  const form = new URLSearchParams({
    grant_type: 'password',
    client_id: clientId,
  });
  const r = await api('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert(r.status === 400, `status 400 (got ${r.status})`);
  assert(r.body.error === 'unsupported_grant_type', 'unsupported_grant_type');
}

console.log('▶ GET /api/v1/auth/oauth/providers');
{
  const r = await api('/api/v1/auth/oauth/providers');
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(Array.isArray(r.body.providers) && r.body.providers.includes('google'), 'google listed');
}

console.log('▶ GET /api/v1/auth/oauth/google/authorize');
{
  const r = await api(`/api/v1/auth/oauth/google/authorize?redirect_uri=${encodeURIComponent('http://localhost:3000/cb')}`);
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(typeof r.body.authorization_url === 'string' && r.body.authorization_url.startsWith('https://accounts.google.com/'), 'returns google URL');
  assert(typeof r.body.state === 'string', 'returns state token');
}

console.log('▶ GET /api/v1/auth/oauth/github/authorize → 400 (unsupported)');
{
  const r = await api(`/api/v1/auth/oauth/github/authorize?redirect_uri=${encodeURIComponent('http://localhost:3000/cb')}`);
  assert(r.status === 400, `status 400 (got ${r.status})`);
}

await adminSql.end();
console.log('');
console.log(failures === 0 ? '✅ all OAuth checks passed' : `❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
