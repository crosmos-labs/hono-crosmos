import {
  dailyUsage,
  memorySpaces,
  recordIngestionUsage,
  recordSearchUsage,
  type Database,
} from '@crosmos/db';
import { and, count, eq, gte, lte, sum } from 'drizzle-orm';
import type { TenantScope } from '../../lib/scope';

/**
 * Per-space usage rollup for a date range (inclusive). Sums the daily_usage
 * counters for one space — the unit a developer bills/attributes to a single
 * end-user when they map one space per end-user. `date` bounds are `YYYY-MM-DD`
 * strings (the daily_usage grain). Returns zeros when the space has no rows in
 * the window.
 */
export async function getSpaceUsage(
  db: Database,
  input: { orgId: number; spaceId: number; start: string; end: string },
): Promise<{ tokensIngested: number; searchQueries: number }> {
  const [row] = await db
    .select({
      tokens: sum(dailyUsage.tokensIngested),
      queries: sum(dailyUsage.searchQueries),
    })
    .from(dailyUsage)
    .where(
      and(
        eq(dailyUsage.orgId, input.orgId),
        eq(dailyUsage.spaceId, input.spaceId),
        gte(dailyUsage.date, input.start),
        lte(dailyUsage.date, input.end),
      ),
    );
  return {
    tokensIngested: Number(row?.tokens ?? 0),
    searchQueries: Number(row?.queries ?? 0),
  };
}

export async function getOrgUsage(
  db: Database,
  input: { orgId: number; start: string; end: string },
): Promise<{ tokens: number; queries: number; spaces: number }> {
  const [usage] = await db.select({
    tokens: sum(dailyUsage.tokensIngested),
    queries: sum(dailyUsage.searchQueries),
  }).from(dailyUsage).where(and(
    eq(dailyUsage.orgId, input.orgId),
    gte(dailyUsage.date, input.start),
    lte(dailyUsage.date, input.end),
  ));
  const [spaceCount] = await db.select({ count: count() })
    .from(memorySpaces)
    .where(eq(memorySpaces.orgId, input.orgId));
  return {
    tokens: Number(usage?.tokens ?? 0),
    queries: Number(usage?.queries ?? 0),
    spaces: spaceCount?.count ?? 0,
  };
}

/**
 * Atomic upsert for `daily_usage.tokens_ingested`. Recorded **once per job**
 * at the terminal transition — not per-source — to keep the row count
 * bounded. Mirrors Python's `record_ingestion_tokens`.
 *
 * The upsert uses the `uq_daily_usage_org_space_date` constraint so two
 * concurrent jobs in the same (org, user, space, day) sum correctly.
 */
export async function recordIngestionTokens(
  db: Database,
  scope: TenantScope,
  tokens: number,
): Promise<void> {
  await recordIngestionUsage(db, scope, {
    tokens,
    completedSourceIds: [],
    failedSourceIds: [],
  });
}

/** Sibling for retrieval — keeps both upserts in one place. */
export async function recordSearchQueries(
  db: Database,
  scope: TenantScope,
  queries: number,
): Promise<void> {
  await recordSearchUsage(db, scope, queries);
}
