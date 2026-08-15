#!/usr/bin/env bun

type FilterName = 'request_id' | 'correlation_id' | 'org_id' | 'event' | 'level';
type Options = {
  from: Date;
  to: Date;
  filters: Partial<Record<FilterName, string>>;
  count: boolean;
  bucket: string;
  objectTemplate: string;
};

const USAGE = `Query the 8-to-90-day Cloudflare Worker log archive in R2.

Usage:
  bun scripts/query-logs.ts --from <ISO/date> --to <ISO/date> --request-id <id>
  bun scripts/query-logs.ts --from <ISO/date> --to <ISO/date> --correlation-id <id>
  bun scripts/query-logs.ts --from <ISO/date> --to <ISO/date> --event <name> [--level error]

Filters (combined with AND): --request-id, --correlation-id, --org-id, --event,
--level. Add --count to print only the matching invocation count.

Requires the DuckDB CLI and read-only, bucket-scoped environment variables:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
Optional:
  R2_LOG_BUCKET=cloudflare-managed-9459b43b
  R2_LOG_OBJECT_TEMPLATE=s3://cloudflare-managed-9459b43b/{date}/*.gz

{date} is expanded as YYYYMMDD for every UTC day in the requested range.
`;

function requiredEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function date(value: string, endOfDay: boolean): Date {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid date ${JSON.stringify(value)}`);
  return parsed;
}

export function parseArgs(args: string[]): Options | 'help' {
  if (args.includes('--help') || args.includes('-h')) return 'help';
  const values = new Map<string, string>();
  let count = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    if (flag === '--count') {
      count = true;
      continue;
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (!['--from', '--to', '--request-id', '--correlation-id', '--org-id', '--event', '--level'].includes(flag)) {
      throw new Error(`Unknown argument ${flag}`);
    }
    values.set(flag, value);
    i += 1;
  }
  const from = date(values.get('--from') ?? '', false);
  const to = date(values.get('--to') ?? '', true);
  if (from >= to) throw new Error('--from must precede --to');
  if (to.getTime() - from.getTime() > 91 * 86_400_000) {
    throw new Error('A query may cover at most 91 days');
  }
  const mappings: Array<[string, FilterName]> = [
    ['--request-id', 'request_id'],
    ['--correlation-id', 'correlation_id'],
    ['--org-id', 'org_id'],
    ['--event', 'event'],
    ['--level', 'level'],
  ];
  const filters: Options['filters'] = {};
  for (const [flag, field] of mappings) {
    const value = values.get(flag)?.trim();
    if (value) filters[field] = value;
  }
  if (Object.keys(filters).length === 0) throw new Error('At least one log filter is required');
  const bucket = Bun.env.R2_LOG_BUCKET?.trim() || 'cloudflare-managed-9459b43b';
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(bucket)) throw new Error('R2_LOG_BUCKET is invalid');
  const objectTemplate = Bun.env.R2_LOG_OBJECT_TEMPLATE?.trim()
    || `s3://${bucket}/{date}/*.gz`;
  if (!objectTemplate.startsWith(`s3://${bucket}/`) || !objectTemplate.includes('{date}')) {
    throw new Error('R2_LOG_OBJECT_TEMPLATE must target R2_LOG_BUCKET and contain {date}');
  }
  return { from, to, filters, count, bucket, objectTemplate };
}

function utcDates(from: Date, to: Date): string[] {
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  const dates: string[] = [];
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10).replaceAll('-', ''));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function buildQuery(options: Options): string {
  const objects = utcDates(options.from, options.to)
    .map((day) => sqlString(options.objectTemplate.replaceAll('{date}', day)))
    .join(', ');
  // Logpush's application records are nested in the invocation's Logs array.
  // Filtering the invocation JSON preserves the complete Cloudflare envelope
  // without coupling this tool to a mutable nested schema.
  // Search field and value separately: Logpush may encode the console record as
  // a nested object or as an escaped JSON string inside `Logs.Message`.
  const filters = Object.entries(options.filters).flatMap(([field, value]) => [
    `position(lower(invocation_json), lower(${sqlString(field)})) > 0`,
    `position(lower(invocation_json), lower(${sqlString(value)})) > 0`,
  ]);
  const time = `event_timestamp_ms >= ${options.from.getTime()} AND event_timestamp_ms <= ${options.to.getTime()}`;
  const projection = options.count
    ? 'count(*) AS matching_invocations'
    : 'invocation_json AS record';
  const order = options.count ? '' : ' ORDER BY event_timestamp_ms, script_name';
  return `WITH archive AS (
    SELECT
      coalesce(try_cast(EventTimestampMs AS BIGINT), 0) AS event_timestamp_ms,
      coalesce(try_cast(ScriptName AS VARCHAR), '') AS script_name,
      CAST(to_json(i) AS VARCHAR) AS invocation_json
    FROM read_ndjson_auto([${objects}], union_by_name = true, filename = true) AS i
  )
  SELECT ${projection} FROM archive
  WHERE ${time} AND ${filters.join(' AND ')}${order};`;
}

function buildBootstrap(options: Options): string {
  const accountId = requiredEnv('R2_ACCOUNT_ID');
  const keyId = requiredEnv('R2_ACCESS_KEY_ID');
  const secret = requiredEnv('R2_SECRET_ACCESS_KEY');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('R2_ACCOUNT_ID is invalid');
  return `INSTALL httpfs; LOAD httpfs;
CREATE OR REPLACE SECRET crosmos_log_archive (
  TYPE s3,
  KEY_ID ${sqlString(keyId)},
  SECRET ${sqlString(secret)},
  REGION 'auto',
  ENDPOINT ${sqlString(`${accountId}.r2.cloudflarestorage.com`)},
  URL_STYLE 'path',
  SCOPE ${sqlString(`s3://${options.bucket}`)}
);
${buildQuery(options)}
DROP SECRET crosmos_log_archive;`;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  if (options === 'help') {
    console.log(USAGE);
    return;
  }
  if (!Bun.which('duckdb')) throw new Error('DuckDB CLI is required (https://duckdb.org/docs/installation/)');
  // SQL goes over stdin so credentials never appear in argv/process listings.
  const child = Bun.spawn(['duckdb', '-json'], {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  child.stdin.write(buildBootstrap(options));
  child.stdin.end();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`DuckDB exited with status ${exitCode}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
