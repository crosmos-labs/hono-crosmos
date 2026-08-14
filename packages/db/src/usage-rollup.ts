import { and, eq, inArray, sql } from 'drizzle-orm';
import { chunks, chunkMemories, dailySourceContentTypes, dailyUsage, sources } from './schema/index';
import type { Database } from './index';

export interface UsageScope {
  orgId: number;
  userId: number;
  spaceId: number;
}

export async function recordSearchUsage(
  db: Database,
  scope: UsageScope,
  queries: number,
): Promise<void> {
  if (queries <= 0) return;
  await db.insert(dailyUsage).values({
    ...scope,
    date: sql`current_date`,
    searchQueries: queries,
  }).onConflictDoUpdate({
    target: [dailyUsage.orgId, dailyUsage.userId, dailyUsage.spaceId, dailyUsage.date],
    set: {
      searchQueries: sql`${dailyUsage.searchQueries} + ${queries}`,
      updatedAt: new Date(),
    },
  });
}

export async function recordIngestionUsage(
  db: Database,
  scope: UsageScope,
  input: {
    tokens: number;
    completedSourceIds: number[];
    failedSourceIds: number[];
  },
): Promise<void> {
  const completedIds = [...new Set(input.completedSourceIds)];
  const failedIds = [...new Set(input.failedSourceIds)];
  if (
    input.tokens <= 0
    && completedIds.length === 0
    && failedIds.length === 0
  ) return;

  await db.transaction(async (tx) => {
    const requestedIds = [...new Set([...completedIds, ...failedIds])];
    const sourceRows = requestedIds.length === 0 ? [] : await tx.select({
      id: sources.id,
      status: sources.extractionStatus,
      contentType: sources.contentType,
      tokenCount: sources.tokenCount,
      meta: sources.meta,
    }).from(sources).where(and(
      eq(sources.orgId, scope.orgId),
      eq(sources.spaceId, scope.spaceId),
      inArray(sources.id, requestedIds),
    )).for('update');
    const completedRequested = new Set(completedIds);
    const failedRequested = new Set(failedIds);
    const completed = sourceRows.filter((source) =>
      completedRequested.has(source.id)
      && source.status === 'completed'
      && (source.meta as Record<string, unknown> | null)?.analytics_completion_recorded !== true);
    const failed = sourceRows.filter((source) =>
      failedRequested.has(source.id)
      && source.status === 'failed'
      && (source.meta as Record<string, unknown> | null)?.analytics_failure_recorded !== true);
    const accountedTokens = completed.length > 0
      ? completed.reduce((sum, source) => sum + source.tokenCount, 0)
      : requestedIds.length === 0 ? Math.max(0, input.tokens) : 0;
    const [memoryRow] = completed.length === 0 ? [{ count: 0 }] : await tx
      .select({ count: sql<number>`count(distinct ${chunkMemories.memoryId})::int` })
      .from(chunks)
      .innerJoin(chunkMemories, eq(chunkMemories.chunkId, chunks.id))
      .where(inArray(chunks.sourceId, completed.map((source) => source.id)));
    const memoriesCreated = Number(memoryRow?.count ?? 0);
    if (accountedTokens === 0 && completed.length === 0 && failed.length === 0) return;

    await tx.insert(dailyUsage).values({
      ...scope,
      date: sql`current_date`,
      tokensIngested: accountedTokens,
      sourcesIngested: completed.length,
      sourcesFailed: failed.length,
      memoriesCreated,
    }).onConflictDoUpdate({
      target: [dailyUsage.orgId, dailyUsage.userId, dailyUsage.spaceId, dailyUsage.date],
      set: {
        tokensIngested: sql`${dailyUsage.tokensIngested} + ${accountedTokens}`,
        sourcesIngested: sql`${dailyUsage.sourcesIngested} + ${completed.length}`,
        sourcesFailed: sql`${dailyUsage.sourcesFailed} + ${failed.length}`,
        memoriesCreated: sql`${dailyUsage.memoriesCreated} + ${memoriesCreated}`,
        updatedAt: new Date(),
      },
    });
    const contentTypes = new Map<string, number>();
    for (const source of completed) {
      contentTypes.set(source.contentType, (contentTypes.get(source.contentType) ?? 0) + 1);
    }
    for (const [contentType, count] of contentTypes) {
      await tx.insert(dailySourceContentTypes).values({
        ...scope,
        date: sql`current_date`,
        contentType,
        count,
      }).onConflictDoUpdate({
        target: [
          dailySourceContentTypes.orgId,
          dailySourceContentTypes.userId,
          dailySourceContentTypes.spaceId,
          dailySourceContentTypes.date,
          dailySourceContentTypes.contentType,
        ],
        set: {
          count: sql`${dailySourceContentTypes.count} + ${count}`,
          updatedAt: new Date(),
        },
      });
    }
    if (completed.length > 0) {
      await tx.update(sources).set({
        meta: sql`jsonb_set(
          case
            when jsonb_typeof(${sources.meta}) = 'object' then ${sources.meta}
            when ${sources.meta} is null then '{}'::jsonb
            else jsonb_build_object('legacy_value', ${sources.meta})
          end,
          '{analytics_completion_recorded}',
          'true'::jsonb
        )`,
      }).where(inArray(sources.id, completed.map((source) => source.id)));
    }
    if (failed.length > 0) {
      await tx.update(sources).set({
        meta: sql`jsonb_set(
          case
            when jsonb_typeof(${sources.meta}) = 'object' then ${sources.meta}
            when ${sources.meta} is null then '{}'::jsonb
            else jsonb_build_object('legacy_value', ${sources.meta})
          end,
          '{analytics_failure_recorded}',
          'true'::jsonb
        )`,
      }).where(inArray(sources.id, failed.map((source) => source.id)));
    }
  });
}
