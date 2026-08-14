#!/usr/bin/env bun
import { createDb, sql } from '../packages/db/src/index';

const USAGE = `Backfill user-facing daily analytics without changing quota counters.

Usage:
  DATABASE_URL=... bun scripts/backfill-analytics.ts --from YYYY-MM-DD --to YYYY-MM-DD --dry-run
  DATABASE_URL=... bun scripts/backfill-analytics.ts --from YYYY-MM-DD --to YYYY-MM-DD --apply

Run dry-run first. The apply path is idempotent: it replaces only analytics
counters and content-type rows in the selected inclusive UTC date range.
`;

export function parseArgs(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) return 'help' as const;
  const from = args[args.indexOf('--from') + 1];
  const to = args[args.indexOf('--to') + 1];
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
    throw new Error('--from and --to must be YYYY-MM-DD');
  }
  if (from! > to!) throw new Error('--from must not be after --to');
  if (apply === dryRun) throw new Error('Choose exactly one of --dry-run or --apply');
  return { from: from!, to: to!, apply };
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  if (options === 'help') { console.log(USAGE); return; }
  const databaseUrl = Bun.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const today = new Date().toISOString().slice(0, 10);
  if (options.apply && options.to >= today) {
    throw new Error('--apply must end before the current UTC date to avoid racing live rollup writes');
  }
  const db = createDb(databaseUrl, { max: 1 });
  const preview = await db.execute(sql`
    WITH source_counts AS (
      SELECT org_id, owner_user_id AS user_id, space_id, created_at::date AS date,
        count(*) FILTER (WHERE extraction_status = 'completed')::int AS sources_ingested,
        count(*) FILTER (WHERE extraction_status = 'failed')::int AS sources_failed
      FROM sources
      WHERE created_at::date BETWEEN ${options.from}::date AND ${options.to}::date
        AND owner_user_id IS NOT NULL
      GROUP BY org_id, owner_user_id, space_id, created_at::date
    ), memory_counts AS (
      SELECT m.org_id, m.owner_user_id AS user_id, m.space_id, m.created_at::date AS date,
        count(*)::int AS memories_created
      FROM memories m
      WHERE m.owner_user_id IS NOT NULL
        AND m.created_at::date BETWEEN ${options.from}::date AND ${options.to}::date
      GROUP BY m.org_id, m.owner_user_id, m.space_id, m.created_at::date
    )
    SELECT count(*)::int AS rollup_rows,
      coalesce(sum(sources_ingested), 0)::int AS sources_ingested,
      coalesce(sum(sources_failed), 0)::int AS sources_failed,
      coalesce(sum(memories_created), 0)::int AS memories_created
    FROM source_counts FULL JOIN memory_counts USING (org_id, user_id, space_id, date)
  `);
  console.log(JSON.stringify({ range: [options.from, options.to], ...preview[0] }, null, 2));
  if (!options.apply) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      WITH source_counts AS (
        SELECT org_id, owner_user_id AS user_id, space_id, created_at::date AS date,
          count(*) FILTER (WHERE extraction_status = 'completed')::int AS sources_ingested,
          count(*) FILTER (WHERE extraction_status = 'failed')::int AS sources_failed
        FROM sources
        WHERE created_at::date BETWEEN ${options.from}::date AND ${options.to}::date
        GROUP BY org_id, owner_user_id, space_id, created_at::date
      ), memory_counts AS (
        SELECT org_id, owner_user_id AS user_id, space_id, created_at::date AS date,
          count(*)::int AS memories_created
        FROM memories
        WHERE owner_user_id IS NOT NULL
          AND created_at::date BETWEEN ${options.from}::date AND ${options.to}::date
        GROUP BY org_id, owner_user_id, space_id, created_at::date
      ), combined AS (
        SELECT org_id, user_id, space_id, date,
          coalesce(sources_ingested, 0) AS sources_ingested,
          coalesce(sources_failed, 0) AS sources_failed,
          coalesce(memories_created, 0) AS memories_created
        FROM source_counts FULL JOIN memory_counts USING (org_id, user_id, space_id, date)
      )
      INSERT INTO daily_usage
        (uuid, org_id, user_id, space_id, date, sources_ingested, sources_failed,
         memories_created, tokens_ingested, search_queries)
      SELECT gen_random_uuid(), org_id, user_id, space_id, date, sources_ingested,
        sources_failed, memories_created, 0, 0 FROM combined
      ON CONFLICT (org_id, user_id, space_id, date) DO UPDATE SET
        sources_ingested = excluded.sources_ingested,
        sources_failed = excluded.sources_failed,
        memories_created = excluded.memories_created,
        updated_at = now()
    `);
    await tx.execute(sql`
      DELETE FROM daily_source_content_types
      WHERE date BETWEEN ${options.from}::date AND ${options.to}::date
    `);
    await tx.execute(sql`
      INSERT INTO daily_source_content_types
        (uuid, org_id, user_id, space_id, date, content_type, count)
      SELECT gen_random_uuid(), org_id, owner_user_id, space_id, created_at::date,
        content_type, count(*)::int
      FROM sources
      WHERE extraction_status = 'completed'
        AND owner_user_id IS NOT NULL
        AND created_at::date BETWEEN ${options.from}::date AND ${options.to}::date
      GROUP BY org_id, owner_user_id, space_id, created_at::date, content_type
    `);
    await tx.execute(sql`
      UPDATE sources
      SET meta = CASE
        WHEN extraction_status = 'completed' THEN
          jsonb_set(coalesce(meta, '{}'::jsonb), '{analytics_completion_recorded}', 'true'::jsonb)
        WHEN extraction_status = 'failed' THEN
          jsonb_set(coalesce(meta, '{}'::jsonb), '{analytics_failure_recorded}', 'true'::jsonb)
        ELSE meta
      END
      WHERE extraction_status IN ('completed', 'failed')
        AND created_at::date BETWEEN ${options.from}::date AND ${options.to}::date
    `);
  });
  console.log('Backfill applied. Re-run --dry-run and reconcile endpoint totals before production.');
}

if (import.meta.main) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
