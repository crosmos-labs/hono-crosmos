#!/usr/bin/env bun
/**
 * Local benchmark bootstrap. Idempotent — safe to re-run.
 *
 * 1. Creates the two Qdrant collections (memories/entities) at EMBEDDING_DIMENSIONS,
 *    Cosine distance, with a spaceId payload index — mirrors ensureQdrantCollections.
 * 2. Seeds a benchmark user + org + owner membership directly in Postgres
 *    (no Google OAuth needed).
 * 3. Mints a `csk_` API key scoped to that org and prints it (and writes it to
 *    ./.bench.env) so the benchmark can authenticate as CROSMOS_BENCH_API_KEY.
 *
 * Run AFTER migrations are applied (scripts/bench-setup.sh does both).
 *
 *   bun scripts/bench-bootstrap.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
// `postgres` is installed in the @crosmos/db workspace, not hoisted to root, and
// the root has no @crosmos/* symlinks — so resolve the driver by its install path
// and talk raw SQL (keeps this setup script free of workspace resolution).
import postgres from '../packages/db/node_modules/postgres/src/index.js';

// --- config (env with sane local defaults) ---------------------------------
const env = loadDevVars(resolve(import.meta.dir, '../apps/api/.dev.vars'));
const DATABASE_URL =
  process.env.DATABASE_URL ?? env.DATABASE_URL ?? 'postgresql://crosmos:crosmos@localhost:5433/crosmos';
const QDRANT_URL = process.env.QDRANT_URL ?? env.QDRANT_URL ?? 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? env.QDRANT_API_KEY ?? 'local-dev-key';
const MEM_COLLECTION =
  process.env.QDRANT_MEMORIES_COLLECTION ?? env.QDRANT_MEMORIES_COLLECTION ?? 'crosmos-memories';
const ENT_COLLECTION =
  process.env.QDRANT_ENTITIES_COLLECTION ?? env.QDRANT_ENTITIES_COLLECTION ?? 'crosmos-entities';
const DIMENSIONS = Number.parseInt(
  process.env.EMBEDDING_DIMENSIONS ?? env.EMBEDDING_DIMENSIONS ?? '1536',
  10,
);

const ORG_SLUG = 'bench-local';
const USER_EMAIL = 'bench@localhost';
const KEY_NAME = 'benchmark-local';

async function main() {
  console.log(`\n== Crosmos local benchmark bootstrap ==`);
  await ensureQdrantCollections();
  const key = await seedAndMintKey();
  writeBenchEnv(key);
  printSummary(key);
}

// --- 1. Qdrant collections --------------------------------------------------
async function ensureQdrantCollections() {
  console.log(`\n[1/3] Qdrant collections @ ${DIMENSIONS}d (Cosine) on ${QDRANT_URL}`);
  const headers = { 'api-key': QDRANT_API_KEY, 'content-type': 'application/json' };
  for (const name of [MEM_COLLECTION, ENT_COLLECTION]) {
    const res = await fetch(`${QDRANT_URL}/collections/${name}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ vectors: { size: DIMENSIONS, distance: 'Cosine' } }),
    });
    if (res.ok) {
      console.log(`      created ${name}`);
    } else {
      const text = await res.text().catch(() => '');
      if (/exist/i.test(text)) {
        // Already exists — verify the dimension matches, since a stale collection
        // at the wrong size silently breaks ingestion (Qdrant rejects vectors).
        const info = await fetch(`${QDRANT_URL}/collections/${name}`, { headers }).then((r) => r.json());
        const size = info?.result?.config?.params?.vectors?.size;
        if (size && size !== DIMENSIONS) {
          throw new Error(
            `Qdrant collection ${name} exists at ${size}d but EMBEDDING_DIMENSIONS=${DIMENSIONS}. ` +
              `Drop it first:  curl -X DELETE ${QDRANT_URL}/collections/${name} -H 'api-key: ${QDRANT_API_KEY}'`,
          );
        }
        console.log(`      exists  ${name} (${size}d) — ok`);
      } else {
        throw new Error(`Qdrant create ${name} failed ${res.status}: ${text}`);
      }
    }
    // spaceId payload index (integer) so the tenant filter is indexed, not a scan.
    await fetch(`${QDRANT_URL}/collections/${name}/index?wait=true`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ field_name: 'spaceId', field_schema: 'integer' }),
    }).catch(() => {});
  }
}

// --- 2 + 3. Seed org + mint API key ----------------------------------------
async function seedAndMintKey() {
  console.log(`\n[2/3] Seeding user/org/membership in Postgres`);
  const sql = postgres(DATABASE_URL, { max: 1, fetch_types: false });
  try {
    // uuid columns default at the Drizzle layer (uuidv7), not in the DB, so raw
    // SQL must supply one — gen_random_uuid() is fine for seed rows.
    const [user] = await sql`
      insert into users (uuid, email, name, is_active)
      values (gen_random_uuid(), ${USER_EMAIL}, 'Benchmark Bot', true)
      on conflict (email) do update set updated_at = now()
      returning id`;
    // Unlimited entitlements (override the 'pro' plan caps). A benchmark run
    // creates ONE space per corpus — up to 500 for LongMemEval — which blows past
    // the pro cap of 50 (POST /spaces then 429s "quota_exceeded" forever). -1 =
    // unlimited everywhere so no artificial cap throttles the run.
    const ENTITLEMENTS = sql.json({
      max_memory_spaces: -1,
      max_sources_per_space: -1,
      monthly_tokens_ingested: -1,
      monthly_search_queries: -1,
      rate_limit_rpm: -1,
      rate_limit_per_day: -1,
      max_members: -1,
      api_keys_per_user: -1,
      retention_days: -1,
    });
    const [org] = await sql`
      insert into organizations (uuid, slug, name, plan, is_personal, created_by_user_id, entitlements)
      values (gen_random_uuid(), ${ORG_SLUG}, 'Benchmark Local', 'pro', true, ${user.id}, ${ENTITLEMENTS})
      on conflict (slug) do update set updated_at = now(), entitlements = ${ENTITLEMENTS}
      returning id`;
    await sql`
      insert into organization_members (uuid, org_id, user_id, role)
      values (gen_random_uuid(), ${org.id}, ${user.id}, 'owner')
      on conflict (org_id, user_id) do nothing`;
    console.log(`      user id=${user.id}  org id=${org.id} (slug=${ORG_SLUG})`);

    console.log(`\n[3/3] Minting API key (csk_…)`);
    // Drop any prior benchmark-local keys so re-runs don't accumulate dead keys.
    await sql`delete from api_keys where org_id = ${org.id} and name = ${KEY_NAME}`;

    const rawKey = `csk_${randomBytes(16).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12);
    await sql`
      insert into api_keys (uuid, org_id, user_id, key_prefix, key_hash, name, is_active)
      values (gen_random_uuid(), ${org.id}, ${user.id}, ${keyPrefix}, ${keyHash}, ${KEY_NAME}, true)`;
    return { rawKey, orgId: org.id as number, userId: user.id as number };
  } finally {
    await sql.end();
  }
}

function writeBenchEnv(key: { rawKey: string }) {
  const openai =
    process.env.OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? 'sk-REPLACE_ME';
  const path = resolve(import.meta.dir, '../.bench.env');
  writeFileSync(
    path,
    `# Source before running the benchmark:  source ${path}\n` +
      `export CROSMOS_BENCH_API_KEY=${key.rawKey}\n` +
      `export CROSMOS_BENCH_SUT_BASE_URL=http://localhost:8787\n` +
      `export OPENAI_API_KEY=${openai}\n`,
  );
  console.log(`\n      wrote ${path}`);
}

function printSummary(key: { rawKey: string }) {
  console.log(`\n== Done ==`);
  console.log(`API key (CROSMOS_BENCH_API_KEY):\n  ${key.rawKey}`);
  console.log(`\nNext:`);
  console.log(`  source .bench.env        # exports the key + base url + OpenAI key`);
  console.log(`  # then run the benchmark from ../benchmark`);
}

// Minimal .dev.vars parser (KEY=VALUE, ignores comments/blank lines).
function loadDevVars(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch {
    /* file optional */
  }
  return out;
}

main().catch((err) => {
  console.error(`\nbootstrap failed: ${err.message}`);
  process.exit(1);
});
