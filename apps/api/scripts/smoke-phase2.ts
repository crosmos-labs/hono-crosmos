#!/usr/bin/env bun
// Phase 2 smoke test.
// 1. Insert test user + personal org + membership directly via SQL.
// 2. Mint a JWT (carrying active_org_id) using the shared @crosmos/auth lib.
// 3. Hit /me, create an API key, list, validate via API key, revoke.
import { readFileSync } from 'node:fs';
import { createTokenPair } from '../src/features/auth/jwt';
import postgres from 'postgres';

const ENV: Record<string, string> = {};
for (const line of readFileSync(
  '/home/iiviie/cursor-projects/crosmos-org/hono-crosmos/apps/api/.dev.vars',
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
const JWT_SECRET = ENV.JWT_SECRET!;
const DATABASE_URL = ENV.DATABASE_URL!;
const BASE = 'http://localhost:8787';

const sql = postgres(DATABASE_URL);

console.log('▶ Cleaning previous smoke-test rows…');
await sql`DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email = 'smoke@crosmos.test')`;
await sql`DELETE FROM api_keys WHERE user_id IN (SELECT id FROM users WHERE email = 'smoke@crosmos.test')`;
await sql`DELETE FROM organizations WHERE slug = 'smoke-test'`;
await sql`DELETE FROM users WHERE email = 'smoke@crosmos.test'`;

console.log('▶ Inserting test user + org…');
const [user] = await sql`
  INSERT INTO users (uuid, email, name)
  VALUES (gen_random_uuid(), 'smoke@crosmos.test', 'Smoke User')
  RETURNING id, uuid, email, name
`;
const [org] = await sql`
  INSERT INTO organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
  VALUES (gen_random_uuid(), 'smoke-test', 'Smoke Org', 'free', true, ${user.id})
  RETURNING id, uuid
`;
await sql`
  INSERT INTO organization_members (uuid, org_id, user_id, role)
  VALUES (gen_random_uuid(), ${org.id}, ${user.id}, 'owner')
`;
console.log(`  user.id=${user.id}  org.id=${org.id}`);

console.log('▶ Minting JWT pair with active_org_id…');
const pair = await createTokenPair(JWT_SECRET, user.id, { activeOrgId: org.id });
const accessToken = pair.accessToken;

async function call(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

let failures = 0;
function assert(cond: any, label: string, ctx?: any) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}`, ctx ?? '');
  }
}

console.log('▶ GET /api/v1/auth/me (JWT)');
{
  const r = await call('/api/v1/auth/me', { token: accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(r.body.email === 'smoke@crosmos.test', 'email matches');
  assert(r.body.id === user.uuid, 'uuid matches');
}

console.log('▶ GET /api/v1/auth/me (no auth → 401)');
{
  const r = await call('/api/v1/auth/me');
  assert(r.status === 401, `status 401 (got ${r.status})`);
}

console.log('▶ PATCH /api/v1/auth/me (rename)');
{
  const r = await call('/api/v1/auth/me', {
    method: 'PATCH',
    token: accessToken,
    body: JSON.stringify({ name: 'Renamed Smoke' }),
  });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.name === 'Renamed Smoke', 'name updated');
}

console.log('▶ POST /api/v1/auth/keys (create API key)');
let apiKeyUuid: string;
let rawKey: string;
{
  const r = await call('/api/v1/auth/keys', {
    method: 'POST',
    token: accessToken,
    body: JSON.stringify({ name: 'smoke-key' }),
  });
  assert(r.status === 201, `status 201 (got ${r.status})`, r.body);
  assert(typeof r.body.raw_key === 'string' && r.body.raw_key.startsWith('csk_'), 'raw_key has csk_ prefix');
  apiKeyUuid = r.body.key_id;
  rawKey = r.body.raw_key;
}

console.log('▶ GET /api/v1/auth/keys (list)');
{
  const r = await call('/api/v1/auth/keys', { token: accessToken });
  assert(r.status === 200 && Array.isArray(r.body.keys) && r.body.keys.length >= 1, 'list returns keys');
}

console.log('▶ GET /api/v1/auth/me (API key auth)');
{
  const r = await call('/api/v1/auth/me', { token: rawKey });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(r.body.email === 'smoke@crosmos.test', 'email matches via API key');
}

console.log('▶ GET /api/v1/auth/keys/validate (API key)');
{
  const r = await call('/api/v1/auth/keys/validate', { token: rawKey });
  assert(r.status === 200 && r.body.valid === true, `validate 200/valid (got ${r.status} ${JSON.stringify(r.body)})`);
}

console.log('▶ GET /api/v1/auth/keys/validate (JWT → should 401, not an API key)');
{
  const r = await call('/api/v1/auth/keys/validate', { token: accessToken });
  assert(r.status === 401, `status 401 (got ${r.status})`);
}

console.log('▶ DELETE /api/v1/auth/keys/{uuid}');
{
  const r = await call(`/api/v1/auth/keys/${apiKeyUuid}`, { method: 'DELETE', token: accessToken });
  assert(r.status === 204, `status 204 (got ${r.status})`);
}

console.log('▶ API key after revocation → should 401');
{
  // KV may still have it cached briefly; we invalidate KV in DELETE, so this should be fresh.
  // Small pause for waitUntil to land.
  await new Promise((r) => setTimeout(r, 200));
  const r = await call('/api/v1/auth/me', { token: rawKey });
  assert(r.status === 401, `status 401 (got ${r.status})`);
}

console.log('▶ POST /api/v1/auth/refresh');
let newAccessToken: string;
{
  const r = await call('/api/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: pair.refreshToken }),
  });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(typeof r.body.access_token === 'string', 'has new access_token');
  assert(r.body.active_org_id === org.uuid, `active_org_id matches (got ${r.body.active_org_id})`);
  newAccessToken = r.body.access_token;
}

console.log('▶ Old refresh token → 401 (rotation revoked it)');
{
  // The DELETE inside /refresh schedules revoke via waitUntil — wait briefly.
  await new Promise((r) => setTimeout(r, 250));
  const r = await call('/api/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: pair.refreshToken }),
  });
  assert(r.status === 401, `status 401 (got ${r.status})`);
}

console.log('▶ POST /api/v1/auth/logout (idempotent)');
{
  // Get a fresh refresh token first
  const fresh = await call('/api/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: (await (async () => {
      // Use newAccessToken to derive — actually we don't have the new refresh.
      // Re-mint cleanly via createTokenPair for this leg.
      return '';
    })()) }),
  });
  // Simpler: just mint a fresh pair and logout that one
  const mintAgain = await createTokenPair(JWT_SECRET, user.id, { activeOrgId: org.id });
  const r1 = await call('/api/v1/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: mintAgain.refreshToken }),
  });
  assert(r1.status === 204, `first logout 204 (got ${r1.status})`);
  const r2 = await call('/api/v1/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: mintAgain.refreshToken }),
  });
  assert(r2.status === 204, `repeat logout 204 (got ${r2.status})`);
}

await sql.end();
console.log('');
console.log(failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
