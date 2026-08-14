import {
  dailySourceContentTypes,
  dailyUsage,
  memorySpaces,
  type Database,
} from '@crosmos/db';
import { and, eq, gte, lt, lte, sql, sum } from 'drizzle-orm';
import { activeSpace } from '../spaces/service';

type Totals = {
  sources_ingested: number;
  sources_failed: number;
  memories_created: number;
  tokens_ingested: number;
  search_queries: number;
};
const ZERO: Totals = {
  sources_ingested: 0, sources_failed: 0, memories_created: 0,
  tokens_ingested: 0, search_queries: 0,
};

const fields = {
  sourcesIngested: sum(dailyUsage.sourcesIngested),
  sourcesFailed: sum(dailyUsage.sourcesFailed),
  memoriesCreated: sum(dailyUsage.memoriesCreated),
  tokensIngested: sum(dailyUsage.tokensIngested),
  searchQueries: sum(dailyUsage.searchQueries),
};

function totals(row: Partial<Record<keyof typeof fields, unknown>> | undefined): Totals {
  return {
    sources_ingested: Number(row?.sourcesIngested ?? 0),
    sources_failed: Number(row?.sourcesFailed ?? 0),
    memories_created: Number(row?.memoriesCreated ?? 0),
    tokens_ingested: Number(row?.tokensIngested ?? 0),
    search_queries: Number(row?.searchQueries ?? 0),
  };
}

function ymd(date: Date): string { return date.toISOString().slice(0, 10); }

export async function getAnalytics(
  db: Database,
  input: { orgId: number; spaceId?: number; days: 30 | 60 | 90; now?: Date },
) {
  const now = input.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - input.days + 1);
  const previousEnd = new Date(start); previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd); previousStart.setUTCDate(previousStart.getUTCDate() - input.days + 1);
  const scope = input.spaceId === undefined ? undefined : eq(dailyUsage.spaceId, input.spaceId);
  const [currentRows, previousRows, dailyRows, contentRows, spaceRows] = await Promise.all([
    db.select(fields).from(dailyUsage).where(and(
      eq(dailyUsage.orgId, input.orgId), scope,
      gte(dailyUsage.date, ymd(start)), lte(dailyUsage.date, ymd(end)),
    )),
    db.select(fields).from(dailyUsage).where(and(
      eq(dailyUsage.orgId, input.orgId), scope,
      gte(dailyUsage.date, ymd(previousStart)), lte(dailyUsage.date, ymd(previousEnd)),
    )),
    db.select({ date: dailyUsage.date, ...fields }).from(dailyUsage).where(and(
      eq(dailyUsage.orgId, input.orgId), scope,
      gte(dailyUsage.date, ymd(start)), lte(dailyUsage.date, ymd(end)),
    )).groupBy(dailyUsage.date).orderBy(dailyUsage.date),
    db.select({
      contentType: dailySourceContentTypes.contentType,
      count: sum(dailySourceContentTypes.count),
    }).from(dailySourceContentTypes).where(and(
      eq(dailySourceContentTypes.orgId, input.orgId),
      input.spaceId === undefined ? undefined : eq(dailySourceContentTypes.spaceId, input.spaceId),
      gte(dailySourceContentTypes.date, ymd(start)),
      lte(dailySourceContentTypes.date, ymd(end)),
    )).groupBy(dailySourceContentTypes.contentType),
    input.spaceId === undefined
      ? db.select({
          id: dailyUsage.spaceId,
          uuid: memorySpaces.uuid,
          name: memorySpaces.name,
          ...fields,
        }).from(dailyUsage)
          .leftJoin(memorySpaces, and(
            eq(memorySpaces.id, dailyUsage.spaceId),
            activeSpace(),
          ))
          .where(and(
            eq(dailyUsage.orgId, input.orgId),
            gte(dailyUsage.date, ymd(start)), lte(dailyUsage.date, ymd(end)),
          ))
          .groupBy(dailyUsage.spaceId, memorySpaces.uuid, memorySpaces.name)
      : Promise.resolve([]),
  ]);
  const byDate = new Map(dailyRows.map((row) => [String(row.date), totals(row)]));
  const daily = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = ymd(cursor);
    daily.push({ date, ...(byDate.get(date) ?? ZERO) });
  }
  return {
    period_start: ymd(start), period_end: ymd(end), days: input.days,
    totals: totals(currentRows[0]),
    previous_period_totals: totals(previousRows[0]),
    daily,
    sources_by_content_type: contentRows.map((row) => ({
      content_type: row.contentType, count: Number(row.count ?? 0),
    })),
    spaces: spaceRows
      .filter((row) => row.uuid !== null)
      .map((row) => ({ space_id: row.uuid!, name: row.name, totals: totals(row) })),
  };
}
