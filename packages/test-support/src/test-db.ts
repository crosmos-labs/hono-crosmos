/**
 * Real-Postgres fixture support for retrieval tests.
 *
 * Some of this work is only provable against a real database. Whether a SQL
 * `WHERE`/`ORDER BY`/`LIMIT` selects exactly the rows a JavaScript filter used
 * to select depends on NULL handling, float comparison, collation and tie-break
 * order — none of which a hand-written fake reproduces faithfully. A fake that
 * "passes" here would be testing the fake.
 *
 * So these suites run against the local `crosmos_test` database (pgvector on
 * :5433, schema built from `packages/db/migrations`). When it is unreachable the
 * suites SKIP rather than fail, so a checkout without Docker still runs the rest
 * of the tests — but skipping is reported, never silently treated as a pass.
 *
 *   docker compose up -d postgres
 *   bash scripts/test-db-setup.sh
 */
import { createDb, type Database } from '@crosmos/db';
import { sql } from 'drizzle-orm';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://crosmos:crosmos@localhost:5433/crosmos_test';

let cached: Database | null = null;
let reachable: boolean | null = null;

/**
 * Connect to the test database, or return `null` if it is not available.
 * Callers should `test.skipIf(db === null)` and print the skip reason once.
 */
export async function getTestDb(): Promise<Database | null> {
  if (reachable === false) return null;
  if (cached !== null) return cached;
  try {
    const db = createDb(TEST_DATABASE_URL, { max: 4 });
    await db.execute(sql`select 1`);
    // `truncate ... cascade` emits one NOTICE per cascaded table, which
    // postgres.js prints as a structured object — dozens of lines per test.
    // `scripts/test-db-setup.sh` sets this at the DATABASE level (a SET here
    // covers only one of the pooled connections); this is a best-effort belt on
    // a database created before that was added.
    await db.execute(sql`set client_min_messages = warning`);
    cached = db;
    reachable = true;
    return db;
  } catch {
    reachable = false;
    return null;
  }
}

/** One-line notice so a skipped suite is visible in the run output. */
export function announceSkip(suite: string): void {
  console.warn(
    `[skip] ${suite}: no test database at ${TEST_DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}. ` +
      'Run `docker compose up -d postgres && bash scripts/test-db-setup.sh`.',
  );
}

/**
 * Remove every row this suite could have created. Ordered child-first even
 * though the FKs cascade, so a partial failure is easier to read.
 */
export async function resetTestData(db: Database): Promise<void> {
  await db.execute(sql`
    truncate table
      edges,
      memory_entities,
      chunk_memories,
      chunks,
      memories,
      entities,
      sources,
      ingestion_jobs,
      daily_usage,
      memory_spaces,
      organization_members,
      organizations,
      users
    restart identity cascade
  `);
}

export interface Tenant {
  userId: number;
  otherUserId: number;
  orgId: number;
  spaceId: number;
}

/** Seed the minimum tenant chain every retrieval fixture needs. */
export async function seedTenant(db: Database): Promise<Tenant> {
  const [owner] = await db.execute<{ id: number }>(sql`
    insert into users (uuid, email, name, is_active)
    values (gen_random_uuid(), 'owner@test.local', 'Owner', true)
    returning id`);
  const [other] = await db.execute<{ id: number }>(sql`
    insert into users (uuid, email, name, is_active)
    values (gen_random_uuid(), 'other@test.local', 'Other', true)
    returning id`);
  const [org] = await db.execute<{ id: number }>(sql`
    insert into organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
    values (gen_random_uuid(), 'test-org', 'Test Org', 'pro', false, ${owner!.id})
    returning id`);
  const [space] = await db.execute<{ id: number }>(sql`
    insert into memory_spaces (uuid, org_id, name, user_id)
    values (gen_random_uuid(), ${org!.id}, 'test-space', ${owner!.id})
    returning id`);

  return {
    userId: owner!.id,
    otherUserId: other!.id,
    orgId: org!.id,
    spaceId: space!.id,
  };
}

export interface SeedMemoryOptions {
  content: string;
  visibility?: 'private' | 'org';
  ownerUserId?: number;
  forgotten?: boolean;
}

export async function seedMemory(
  db: Database,
  tenant: Tenant,
  options: SeedMemoryOptions,
): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    insert into memories
      (uuid, org_id, space_id, owner_user_id, content, memory_type, visibility,
       importance_score, recorded_at, forgotten_at)
    values
      (gen_random_uuid(), ${tenant.orgId}, ${tenant.spaceId},
       ${options.ownerUserId ?? tenant.userId}, ${options.content}, 'semantic',
       ${options.visibility ?? 'org'}, 0.5, now(),
       ${options.forgotten ? sql`now()` : sql`null`})
    returning id`);
  return row!.id;
}

export async function seedEntity(
  db: Database,
  tenant: Tenant,
  name: string,
): Promise<number> {
  // `entities` is deliberately NOT owner-scoped — unlike memories/edges/sources
  // it has no `owner_user_id`. Entity visibility is derived transitively from
  // the memories that link to it, which is why the graph signal filters seeds
  // through `getEntityIdsLinkedToVisibleMemories`.
  const [row] = await db.execute<{ id: number }>(sql`
    insert into entities (uuid, org_id, space_id, name, entity_type)
    values (gen_random_uuid(), ${tenant.orgId}, ${tenant.spaceId}, ${name}, 'object')
    returning id`);
  return row!.id;
}

export interface SeedEdgeOptions {
  sourceEntityId: number;
  targetEntityId: number;
  memoryId?: number | null;
  /** `null` exercises the coalesce-to-1.0 rule. */
  confidence?: number | null;
  validFrom?: Date | null;
  recordedAt?: Date;
  forgotten?: boolean;
  ownerUserId?: number;
  visibility?: 'private' | 'org';
}

export async function seedEdge(
  db: Database,
  tenant: Tenant,
  options: SeedEdgeOptions,
): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    insert into edges
      (uuid, org_id, space_id, owner_user_id, source_entity_id, target_entity_id,
       memory_id, relation_type, confidence, valid_from, recorded_at, visibility,
       forgotten_at)
    values
      (gen_random_uuid(), ${tenant.orgId}, ${tenant.spaceId},
       ${options.ownerUserId ?? tenant.userId},
       ${options.sourceEntityId}, ${options.targetEntityId},
       ${options.memoryId ?? null}, 'related_to',
       ${options.confidence === undefined ? 1.0 : options.confidence},
       ${options.validFrom ? options.validFrom.toISOString() : null},
       ${(options.recordedAt ?? new Date()).toISOString()},
       ${options.visibility ?? 'org'},
       ${options.forgotten ? sql`now()` : sql`null`})
    returning id`);
  return row!.id;
}

export interface SeedJobOptions {
  spaceId?: number;
  status?: 'pending' | 'processing' | 'completed' | 'partial' | 'failed' | 'cancelled';
  sourceIds?: number[];
  /** Backdate `started_at` to simulate an expired lease. */
  startedMinutesAgo?: number | null;
}

/** Insert an ingestion job and return its UUID (the job id used everywhere). */
export async function seedJob(
  db: Database,
  tenant: Tenant,
  options: SeedJobOptions = {},
): Promise<string> {
  const status = options.status ?? 'pending';
  const startedAt =
    options.startedMinutesAgo == null
      ? null
      : sql`now() - (${options.startedMinutesAgo} || ' minutes')::interval`;
  const [row] = await db.execute<{ id: string }>(sql`
    insert into ingestion_jobs (id, org_id, user_id, space_id, status, source_ids, started_at)
    values (gen_random_uuid(), ${tenant.orgId}, ${tenant.userId},
            ${options.spaceId ?? tenant.spaceId}, ${status},
            ${JSON.stringify(options.sourceIds ?? [])}::jsonb, ${startedAt})
    returning id`);
  return row!.id;
}

/** Read a job's current status straight from the row. */
export async function jobStatus(db: Database, jobId: string): Promise<string | null> {
  const [row] = await db.execute<{ status: string }>(
    sql`select status from ingestion_jobs where id = ${jobId}`,
  );
  return row?.status ?? null;
}

/** Create an additional space in the same org, optionally already tombstoned. */
export async function seedSpace(
  db: Database,
  tenant: Tenant,
  name: string,
  options: { deleted?: boolean } = {},
): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    insert into memory_spaces (uuid, org_id, name, user_id, deleted_at)
    values (gen_random_uuid(), ${tenant.orgId}, ${name}, ${tenant.userId},
            ${options.deleted ? sql`now()` : sql`null`})
    returning id`);
  return row!.id;
}
