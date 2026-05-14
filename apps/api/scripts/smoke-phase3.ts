#!/usr/bin/env bun
// Phase 3 smoke test — organizations API.
// Sets up: owner user (also member of a second org), a 'member'-role user,
// then exercises list/get/patch/entitlements + RBAC + slug collision.
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

console.log('▶ Cleaning previous smoke-test rows…');
await sql`DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email IN ('owner-p3@crosmos.test', 'member-p3@crosmos.test'))`;
await sql`DELETE FROM organizations WHERE slug IN ('owner-p3-org', 'second-p3-org', 'taken-slug-p3', 'renamed-p3-org')`;
await sql`DELETE FROM users WHERE email IN ('owner-p3@crosmos.test', 'member-p3@crosmos.test')`;

console.log('▶ Inserting two users + two orgs + memberships…');
const [owner] = await sql`
  INSERT INTO users (uuid, email, name)
  VALUES (gen_random_uuid(), 'owner-p3@crosmos.test', 'Owner P3')
  RETURNING id, uuid
`;
const [memberUser] = await sql`
  INSERT INTO users (uuid, email, name)
  VALUES (gen_random_uuid(), 'member-p3@crosmos.test', 'Member P3')
  RETURNING id, uuid
`;
const [orgA] = await sql`
  INSERT INTO organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
  VALUES (gen_random_uuid(), 'owner-p3-org', 'Owner P3 Org', 'free', true, ${owner.id})
  RETURNING id, uuid
`;
const [orgB] = await sql`
  INSERT INTO organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
  VALUES (gen_random_uuid(), 'second-p3-org', 'Second P3 Org', 'developer', false, ${owner.id})
  RETURNING id, uuid
`;
// Pre-existing org with a taken slug, for collision test
const [orgC] = await sql`
  INSERT INTO organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
  VALUES (gen_random_uuid(), 'taken-slug-p3', 'Taken Slug', 'free', false, ${owner.id})
  RETURNING id, uuid
`;
await sql`INSERT INTO organization_members (uuid, org_id, user_id, role) VALUES (gen_random_uuid(), ${orgA.id}, ${owner.id}, 'owner')`;
await sql`INSERT INTO organization_members (uuid, org_id, user_id, role) VALUES (gen_random_uuid(), ${orgB.id}, ${owner.id}, 'owner')`;
// memberUser is a *member*-role of orgA — useful to test RBAC denial
await sql`INSERT INTO organization_members (uuid, org_id, user_id, role) VALUES (gen_random_uuid(), ${orgA.id}, ${memberUser.id}, 'member')`;

console.log(`  owner.id=${owner.id} orgA.uuid=${orgA.uuid} orgB.uuid=${orgB.uuid} orgC.uuid=${orgC.uuid}`);

// Mint tokens with each user/org context
const ownerTokensA = await createTokenPair(JWT_SECRET, owner.id, { activeOrgId: orgA.id });
const ownerTokensB = await createTokenPair(JWT_SECRET, owner.id, { activeOrgId: orgB.id });
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

console.log('▶ GET /api/v1/orgs (owner sees 2 orgs)');
{
  const r = await call('/api/v1/orgs', { token: ownerTokensA.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(Array.isArray(r.body.orgs) && r.body.orgs.length === 2, `2 orgs (got ${r.body.orgs?.length})`);
  // owner role on both
  assert(r.body.orgs.every((o: any) => o.your_role === 'owner'), 'all owner role');
  // member_count: orgA has 2 (owner + member), orgB has 1
  const a = r.body.orgs.find((o: any) => o.id === orgA.uuid);
  const b = r.body.orgs.find((o: any) => o.id === orgB.uuid);
  assert(a?.member_count === 2, `orgA member_count=2 (got ${a?.member_count})`);
  assert(b?.member_count === 1, `orgB member_count=1 (got ${b?.member_count})`);
  assert(r.body.next_cursor === null, 'no next_cursor');
}

console.log('▶ GET /api/v1/orgs?limit=1 → next_cursor set');
{
  const r = await call('/api/v1/orgs?limit=1', { token: ownerTokensA.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.orgs.length === 1, `1 org returned`);
  assert(typeof r.body.next_cursor === 'string' && r.body.next_cursor.length > 0, 'next_cursor present');
}

console.log('▶ GET /api/v1/orgs (member-role user sees 1 org)');
{
  const r = await call('/api/v1/orgs', { token: memberTokensA.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.orgs.length === 1, `1 org`);
  assert(r.body.orgs[0]?.your_role === 'member', 'member role');
}

console.log('▶ GET /api/v1/orgs/{uuid} (owner)');
{
  const r = await call(`/api/v1/orgs/${orgA.uuid}`, { token: ownerTokensA.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.id === orgA.uuid, 'returned correct org');
  assert(r.body.your_role === 'owner', 'owner role');
}

console.log('▶ GET /api/v1/orgs/{uuid} (member of org → member role)');
{
  const r = await call(`/api/v1/orgs/${orgA.uuid}`, { token: memberTokensA.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.your_role === 'member', 'member role');
}

console.log('▶ GET /api/v1/orgs/{uuid} (non-member → 404)');
{
  // memberUser is NOT a member of orgB
  const memberTokensB = await createTokenPair(JWT_SECRET, memberUser.id, { activeOrgId: orgA.id });
  const r = await call(`/api/v1/orgs/${orgB.uuid}`, { token: memberTokensB.accessToken });
  assert(r.status === 404, `status 404 (got ${r.status})`);
}

console.log('▶ GET /api/v1/orgs/{bogus uuid} → 404');
{
  const r = await call('/api/v1/orgs/00000000-0000-7000-8000-000000000000', { token: ownerTokensA.accessToken });
  assert(r.status === 404, `status 404 (got ${r.status})`);
}

console.log('▶ PATCH /api/v1/orgs/{uuid} (owner can rename)');
{
  const r = await call(`/api/v1/orgs/${orgA.uuid}`, {
    method: 'PATCH',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ name: '  Renamed Org  ' }), // tests trim()
  });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(r.body.name === 'Renamed Org', `name trimmed (got "${r.body.name}")`);
}

console.log('▶ PATCH /api/v1/orgs/{uuid} (slug change → success)');
{
  const r = await call(`/api/v1/orgs/${orgA.uuid}`, {
    method: 'PATCH',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ slug: 'renamed-p3-org' }),
  });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.slug === 'renamed-p3-org', 'slug updated');
}

console.log('▶ PATCH /api/v1/orgs/{uuid} (slug collision → 409)');
{
  const r = await call(`/api/v1/orgs/${orgA.uuid}`, {
    method: 'PATCH',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ slug: 'taken-slug-p3' }), // orgC has this slug
  });
  assert(r.status === 409, `status 409 (got ${r.status})`, r.body);
  assert(r.body?.detail?.error === 'slug_taken', `error=slug_taken (got ${JSON.stringify(r.body?.detail)})`);
}

console.log('▶ PATCH /api/v1/orgs/{uuid} (invalid slug pattern → 400)');
{
  const r = await call(`/api/v1/orgs/${orgA.uuid}`, {
    method: 'PATCH',
    token: ownerTokensA.accessToken,
    body: JSON.stringify({ slug: 'Invalid Slug!' }),
  });
  assert(r.status === 400, `status 400 (got ${r.status})`);
}

console.log('▶ PATCH /api/v1/orgs/{uuid} (member role → 403)');
{
  const r = await call(`/api/v1/orgs/${orgA.uuid}`, {
    method: 'PATCH',
    token: memberTokensA.accessToken,
    body: JSON.stringify({ name: 'Should Not Work' }),
  });
  assert(r.status === 403, `status 403 (got ${r.status})`, r.body);
  assert(r.body?.detail === 'insufficient_role', `detail=insufficient_role (got ${JSON.stringify(r.body?.detail)})`);
}

console.log('▶ PATCH /api/v1/orgs/{uuid} (token has different active_org_id → 404)');
{
  // Owner's tokens carry active_org_id=orgB, but path is orgA. Should 404.
  const r = await call(`/api/v1/orgs/${orgA.uuid}`, {
    method: 'PATCH',
    token: ownerTokensB.accessToken,
    body: JSON.stringify({ name: 'cross-org attempt' }),
  });
  assert(r.status === 404, `status 404 (got ${r.status})`, r.body);
}

console.log('▶ GET /api/v1/orgs/{uuid}/entitlements (free plan)');
{
  const r = await call(`/api/v1/orgs/${orgA.uuid}/entitlements`, { token: ownerTokensA.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`, r.body);
  assert(r.body.plan === 'free', `plan=free (got ${r.body.plan})`);
  assert(r.body.entitlements?.max_memory_spaces === 3, `free.max_memory_spaces=3 (got ${r.body.entitlements?.max_memory_spaces})`);
  assert(r.body.entitlements?.monthly_tokens_ingested === 500_000, 'free tokens cap');
  assert(r.body.usage_this_month?.tokens_ingested === 0, 'usage zero (DailyUsage not migrated yet)');
  assert(r.body.usage_this_month?.search_queries === 0, 'queries zero');
}

console.log('▶ GET /api/v1/orgs/{uuid}/entitlements (developer plan)');
{
  const r = await call(`/api/v1/orgs/${orgB.uuid}/entitlements`, { token: ownerTokensB.accessToken });
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.body.plan === 'developer', 'plan=developer');
  assert(r.body.entitlements?.max_memory_spaces === 7, 'developer cap');
  assert(r.body.entitlements?.monthly_tokens_ingested === 5_000_000, 'developer tokens cap');
}

console.log('▶ GET /api/v1/orgs (no auth → 401)');
{
  const r = await call('/api/v1/orgs');
  assert(r.status === 401, `status 401 (got ${r.status})`);
}

console.log('▶ GET /api/v1/orgs/{uuid}/entitlements (JWT without active_org_id → 400)');
{
  const noOrgTokens = await createTokenPair(JWT_SECRET, owner.id, { activeOrgId: null });
  const r = await call(`/api/v1/orgs/${orgA.uuid}/entitlements`, { token: noOrgTokens.accessToken });
  assert(r.status === 400, `status 400 (got ${r.status})`);
  assert(r.body?.detail === 'no_org_context', `detail=no_org_context (got ${JSON.stringify(r.body?.detail)})`);
}

await sql.end();
console.log('');
console.log(failures === 0 ? '✅ all Phase 3 checks passed' : `❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
