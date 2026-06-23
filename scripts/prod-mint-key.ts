#!/usr/bin/env bun
/**
 * One-off: mint a prod API key directly in the Neon prod DB for the latency
 * bench. Mirrors scripts/bench-bootstrap.ts (seed user/org/membership + csk_
 * key) but against PRODUCTION and WITHOUT touching Qdrant (prod collections
 * already exist). Idempotent on the org/user; rotates the named key each run.
 */
import { createHash, randomBytes } from 'node:crypto';
import postgres from '../packages/db/node_modules/postgres/src/index.js';

const DATABASE_URL = process.env.PROD_DATABASE_URL!;
if (!DATABASE_URL) throw new Error('set PROD_DATABASE_URL');

const ORG_SLUG = 'latency-bench-prod';
const USER_EMAIL = 'latency-bench@crosmos.dev';
const KEY_NAME = 'latency-bench-2026-06-22';

const sql = postgres(DATABASE_URL, { max: 1, fetch_types: false });
try {
  const [user] = await sql`
    insert into users (uuid, email, name, is_active)
    values (gen_random_uuid(), ${USER_EMAIL}, 'Latency Bench', true)
    on conflict (email) do update set updated_at = now()
    returning id`;
  const ENTITLEMENTS = sql.json({
    max_memory_spaces: -1, max_sources_per_space: -1, monthly_tokens_ingested: -1,
    monthly_search_queries: -1, rate_limit_rpm: -1, rate_limit_per_day: -1,
    max_members: -1, api_keys_per_user: -1, retention_days: -1,
  });
  const [org] = await sql`
    insert into organizations (uuid, slug, name, plan, is_personal, created_by_user_id, entitlements)
    values (gen_random_uuid(), ${ORG_SLUG}, 'Latency Bench Prod', 'pro', true, ${user.id}, ${ENTITLEMENTS})
    on conflict (slug) do update set updated_at = now(), entitlements = ${ENTITLEMENTS}
    returning id`;
  await sql`
    insert into organization_members (uuid, org_id, user_id, role)
    values (gen_random_uuid(), ${org.id}, ${user.id}, 'owner')
    on conflict (org_id, user_id) do nothing`;
  await sql`delete from api_keys where org_id = ${org.id} and name = ${KEY_NAME}`;
  const rawKey = `csk_${randomBytes(16).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  await sql`
    insert into api_keys (uuid, org_id, user_id, key_prefix, key_hash, name, is_active)
    values (gen_random_uuid(), ${org.id}, ${user.id}, ${rawKey.slice(0, 12)}, ${keyHash}, ${KEY_NAME}, true)`;
  console.log(rawKey);
} finally {
  await sql.end();
}
