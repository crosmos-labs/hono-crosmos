#!/usr/bin/env bun
// Smoke test for spaces routes. Mirrors Python behavior:
//   - POST allows all roles (owner/admin/member)
//   - DELETE only owner/admin
//   - Cross-tenant access → 404
//   - max_memory_spaces quota → 429
//   - ?name= filter exact match
import { readFileSync } from 'node:fs';
import { createTokenPair } from '../src/features/auth/jwt';
import postgres from 'postgres';

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
const JWT_SECRET = ENV.JWT_SECRET!;
const DATABASE_URL = ENV.DATABASE_URL!;
const BASE = 'http://localhost:8787';

const sql = postgres(DATABASE_URL);

console.log('▶ Cleaning previous rows…');
await sql`DELETE FROM memory_spaces WHERE org_id IN (SELECT id FROM organizations WHERE slug LIKE 'spaces-test-%')`;
await sql`DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email IN ('spaces-owner@crosmos.test','spaces-member@crosmos.test'))`;
await sql`DELETE FROM organizations WHERE slug LIKE 'spaces-test-%'`;
await sql`DELETE FROM users WHERE email IN ('spaces-owner@crosmos.test','spaces-member@crosmos.test')`;

console.log('▶ Setting up fixtures…');
const [owner] = await sql`
  INSERT INTO users (uuid, email, name) VALUES (gen_random_uuid(), 'spaces-owner@crosmos.test', 'Spaces Owner')
  RETURNING id, uuid
`;
const [memberUser] = await sql`
  INSERT INTO users (uuid, email, name) VALUES (gen_random_uuid(), 'spaces-member@crosmos.test', 'Spaces Member')
  RETURNING id, uuid
`;
// Space count is unlimited on every plan now — no per-plan space cap to test.
const [orgA] = await sql`
  INSERT INTO organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
  VALUES (gen_random_uuid(), 'spaces-test-a', 'Spaces Test A', 'free', true, ${owner.id})
  RETURNING id, uuid
`;
const [orgB] = await sql`
  INSERT INTO organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
  VALUES (gen_random_uuid(), 'spaces-test-b', 'Spaces Test B', 'developer', false, ${owner.id})
  RETURNING id, uuid
`;
await sql`INSERT INTO organization_members (uuid, org_id, user_id, role) VALUES (gen_random_uuid(), ${orgA.id}, ${owner.id}, 'owner')`;
await sql`INSERT INTO organization_members (uuid, org_id, user_id, role) VALUES (gen_random_uuid(), ${orgA.id}, ${memberUser.id}, 'member')`;
await sql`INSERT INTO organization_members (uuid, org_id, user_id, role) VALUES (gen_random_uuid(), ${orgB.id}, ${owner.id}, 'owner')`;

// Pre-existing space in orgB for the cross-tenant test
const [orgBSpace] = await sql`
  INSERT INTO memory_spaces (uuid, org_id, user_id, name, description)
  VALUES (gen_random_uuid(), ${orgB.id}, ${owner.id}, 'orgB-space', null)
  RETURNING id, uuid
`;

const ownerTokensA = await createTokenPair(JWT_SECRET, owner.id, { activeOrgId: orgA.id });
const memberTokensA = await createTokenPair(JWT_SECRET, memberUser.id, { activeOrgId: orgA.id });

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
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}`, ctx ?? ''); }
}

console.log('▶ GET /api/v1/spaces (orgA, empty)');
{
  const r = await call('/api/v1/spaces', { token: ownerTokensA.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(r.body.total === 0, `total=0 (got ${r.body.total})`);
}

console.log('▶ POST /api/v1/spaces (owner creates "alpha")');
let spaceAlphaUuid: string;
{
  const r = await call('/api/v1/spaces', {
    method: 'POST',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ name: 'alpha', description: 'first space', meta: { k: 'v' } }),
  });
  assert(r.status === 201, `status 201 (got ${r.status})`, r.body);
  assert(r.body.name === 'alpha', 'name=alpha');
  assert(r.body.org_id === orgA.uuid, 'org_id is org UUID');
  assert(r.body.description === 'first space', 'description preserved');
  assert(r.body.meta?.k === 'v', 'meta preserved');
  spaceAlphaUuid = r.body.id;
}

console.log('▶ POST /api/v1/spaces (member role can also create)');
{
  const r = await call('/api/v1/spaces', {
    method: 'POST',
    token: memberTokensA.accessToken,
    body: JSON.stringify({ name: 'beta' }),
  });
  assert(r.status === 201, `status 201 (got ${r.status})`, r.body);
  assert(r.body.name === 'beta', 'name=beta');
}

console.log('▶ POST /api/v1/spaces (third space → still ok)');
{
  const r = await call('/api/v1/spaces', {
    method: 'POST',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ name: 'gamma' }),
  });
  assert(r.status === 201, `status 201 (got ${r.status})`);
}

console.log('▶ POST /api/v1/spaces (4th, no space cap → still 201)');
{
  const r = await call('/api/v1/spaces', {
    method: 'POST',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ name: 'delta' }),
  });
  assert(r.status === 201, `status 201 (got ${r.status})`, r.body);
  assert(r.body.name === 'delta', 'name=delta');
}

console.log('▶ GET /api/v1/spaces (lists 4)');
{
  const r = await call('/api/v1/spaces', { token: ownerTokensA.accessToken });
  assert(r.status === 200, 'status 200');
  assert(r.body.total === 4, `total=4 (got ${r.body.total})`);
  // Order is created_at ASC: alpha, beta, gamma, delta
  assert(r.body.spaces[0]?.name === 'alpha', 'first=alpha');
  assert(r.body.spaces[1]?.name === 'beta', 'second=beta');
  assert(r.body.spaces[2]?.name === 'gamma', 'third=gamma');
  assert(r.body.spaces[3]?.name === 'delta', 'fourth=delta');
}

console.log('▶ GET /api/v1/spaces?name=beta (exact match)');
{
  const r = await call('/api/v1/spaces?name=beta', { token: ownerTokensA.accessToken });
  assert(r.status === 200, 'status 200');
  assert(r.body.total === 1, `total=1 (got ${r.body.total})`);
  assert(r.body.spaces[0]?.name === 'beta', 'matched beta');
}

console.log('▶ GET /api/v1/spaces?name=does-not-exist (no match → empty list)');
{
  const r = await call('/api/v1/spaces?name=does-not-exist', { token: ownerTokensA.accessToken });
  assert(r.status === 200, 'status 200');
  assert(r.body.total === 0, 'total=0');
}

console.log('▶ GET /api/v1/spaces/{uuid} (own space)');
{
  const r = await call(`/api/v1/spaces/${spaceAlphaUuid}`, { token: ownerTokensA.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.id === spaceAlphaUuid, 'correct space');
}

console.log('▶ GET /api/v1/spaces/{uuid} (cross-tenant orgB space from orgA token → 404)');
{
  const r = await call(`/api/v1/spaces/${orgBSpace.uuid}`, { token: ownerTokensA.accessToken });
  assert(r.status === 404, `status 404 (got ${r.status})`);
}

console.log('▶ GET /api/v1/spaces/{bogus uuid} → 404');
{
  const r = await call('/api/v1/spaces/00000000-0000-7000-8000-000000000000', { token: ownerTokensA.accessToken });
  assert(r.status === 404, `status 404 (got ${r.status})`);
}

console.log('▶ DELETE /api/v1/spaces/{uuid} (member role → 403)');
{
  const r = await call(`/api/v1/spaces/${spaceAlphaUuid}`, {
    method: 'DELETE',
    token: memberTokensA.accessToken,
  });
  assert(r.status === 403, `status 403 (got ${r.status})`, r.body);
  assert(r.body?.detail === 'insufficient_role', `detail=insufficient_role`);
}

console.log('▶ DELETE /api/v1/spaces/{uuid} (owner → 204)');
{
  const r = await call(`/api/v1/spaces/${spaceAlphaUuid}`, {
    method: 'DELETE',
    token: ownerTokensA.accessToken,
  });
  assert(r.status === 204, `status 204 (got ${r.status})`);
}

console.log('▶ DELETE same space again → 404');
{
  const r = await call(`/api/v1/spaces/${spaceAlphaUuid}`, {
    method: 'DELETE',
    token: ownerTokensA.accessToken,
  });
  assert(r.status === 404, `status 404 (got ${r.status})`);
}

console.log('▶ POST after delete should succeed (count is back to 2 < 3)');
{
  const r = await call('/api/v1/spaces', {
    method: 'POST',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ name: 'epsilon' }),
  });
  assert(r.status === 201, `status 201 (got ${r.status})`, r.body);
}

console.log('▶ POST duplicate name within same org → DB unique constraint (500/400)');
{
  // The unique (org_id, name) constraint will throw IntegrityError. Python doesn't
  // explicitly catch — neither do we. Either way it must NOT be 201.
  const r = await call('/api/v1/spaces', {
    method: 'POST',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ name: 'beta' }), // beta exists
  });
  assert(r.status >= 400 && r.status < 600 && r.status !== 201, `non-2xx (got ${r.status})`);
}

console.log('▶ DELETE cross-tenant orgB space from orgA token → 404');
{
  const r = await call(`/api/v1/spaces/${orgBSpace.uuid}`, {
    method: 'DELETE',
    token: ownerTokensA.accessToken,
  });
  assert(r.status === 404, `status 404 (got ${r.status})`);
}

console.log('▶ No auth → 401');
{
  const r = await call('/api/v1/spaces');
  assert(r.status === 401, `status 401 (got ${r.status})`);
}

console.log('▶ JWT without active_org_id → 400 no_org_context');
{
  const noOrgTokens = await createTokenPair(JWT_SECRET, owner.id, { activeOrgId: null });
  const r = await call('/api/v1/spaces', { token: noOrgTokens.accessToken });
  assert(r.status === 400, `status 400 (got ${r.status})`);
  assert(r.body?.detail === 'no_org_context', `detail=no_org_context`);
}

await sql.end();
console.log('');
console.log(failures === 0 ? '✅ all spaces checks passed' : `❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
