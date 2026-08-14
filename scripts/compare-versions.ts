#!/usr/bin/env bun

type Window = { label: string; where: string };
type Row = Record<string, string | number | null>;

const MIN_PERCENTILE_SAMPLES = 100;
const USAGE = `Compare two API metric cohorts in Cloudflare Analytics Engine.

Usage:
  bun scripts/compare-versions.ts --before-version <8-char-id> --after-version <8-char-id>
  bun scripts/compare-versions.ts --before <start>,<end> --after <start>,<end>

Options:
  --dataset <name>      Defaults to crosmos_api.
  --min-samples <n>     Defaults to ${MIN_PERCENTILE_SAMPLES}.

Environment: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Analytics Read).
`;

export type CompareOptions = {
  accountId: string;
  apiToken: string;
  dataset: string;
  before: Window;
  after: Window;
  minSamples: number;
};

function env(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function versionWindow(label: string, version: string): Window {
  if (!/^[a-f0-9]{8}$/i.test(version)) {
    throw new Error(`${label} version must be the 8-character metric version id`);
  }
  return { label: `${label}:${version}`, where: `blob4 = ${sqlString(version)}` };
}

function timeWindow(label: string, value: string): Window {
  const [start, end, extra] = value.split(',');
  if (!start || !end || extra || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) {
    throw new Error(`${label} must be <ISO-start>,<ISO-end>`);
  }
  if (Date.parse(start) >= Date.parse(end)) throw new Error(`${label} start must precede end`);
  return {
    label: `${label}:${start}..${end}`,
    where: `timestamp >= toDateTime(${sqlString(start)}) AND timestamp < toDateTime(${sqlString(end)})`,
  };
}

export function parseArgs(args: string[]): CompareOptions | 'help' {
  if (args.includes('--help') || args.includes('-h')) return 'help';
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`${flag ?? 'argument'} requires a value`);
    }
    if (!['--before-version', '--after-version', '--before', '--after', '--dataset', '--min-samples'].includes(flag)) {
      throw new Error(`Unknown argument ${flag}`);
    }
    values.set(flag, value);
  }
  const hasVersions = values.has('--before-version') || values.has('--after-version');
  const hasTimes = values.has('--before') || values.has('--after');
  if (hasVersions === hasTimes) throw new Error('Use either two versions or two time windows');
  const before = hasVersions
    ? versionWindow('before', values.get('--before-version') ?? '')
    : timeWindow('before', values.get('--before') ?? '');
  const after = hasVersions
    ? versionWindow('after', values.get('--after-version') ?? '')
    : timeWindow('after', values.get('--after') ?? '');
  const dataset = values.get('--dataset') ?? 'crosmos_api';
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(dataset)) throw new Error('Invalid dataset name');
  const minSamples = Number(values.get('--min-samples') ?? MIN_PERCENTILE_SAMPLES);
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Error('--min-samples must be a positive integer');
  return {
    accountId: env('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: env('CLOUDFLARE_API_TOKEN'),
    dataset,
    before,
    after,
    minSamples,
  };
}

async function query(options: CompareOptions, sql: string): Promise<Row[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
    },
  );
  const body = await response.json() as { data?: Row[]; errors?: Array<{ message?: string }> };
  if (!response.ok || !body.data) {
    throw new Error(body.errors?.map((error) => error.message).join('; ') || `Analytics query failed (${response.status})`);
  }
  return body.data;
}

function num(row: Row, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

export function percentDelta(before: number, after: number): string {
  if (before === 0) return after === 0 ? '0.0%' : 'n/a';
  return `${(((after - before) / before) * 100).toFixed(1)}%`;
}

async function endpointRows(options: CompareOptions, window: Window): Promise<Row[]> {
  return query(options, `SELECT blob5 AS method, blob6 AS path,
    sum(_sample_interval) AS samples,
    quantileExactWeighted(0.50)(double1, _sample_interval) AS p50_ms,
    quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms,
    quantileExactWeighted(0.99)(double1, _sample_interval) AS p99_ms
    FROM ${options.dataset}
    WHERE blob3 = 'http_request' AND ${window.where}
    GROUP BY method, path ORDER BY path, method`);
}

async function statusRows(options: CompareOptions, window: Window): Promise<Row[]> {
  return query(options, `SELECT blob5 AS method, blob6 AS path, blob7 AS status,
    sum(_sample_interval) AS samples
    FROM ${options.dataset}
    WHERE blob3 = 'http_request' AND ${window.where}
    GROUP BY method, path, status`);
}

async function stageRows(options: CompareOptions, window: Window): Promise<Row[]> {
  return query(options, `SELECT blob5 AS stage, blob6 AS outcome,
    sum(_sample_interval) AS samples,
    quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms
    FROM ${options.dataset}
    WHERE blob3 = 'api_stage' AND ${window.where}
    GROUP BY stage, outcome ORDER BY stage, outcome`);
}

async function throttleRows(options: CompareOptions, window: Window): Promise<Row[]> {
  return query(options, `SELECT blob3 AS metric, sum(_sample_interval) AS samples
    FROM ${options.dataset}
    WHERE blob3 IN ('search', 'search_throttled') AND ${window.where}
    GROUP BY metric`);
}

function errorRates(rows: Row[]): Map<string, number> {
  const totals = new Map<string, { all: number; errors: number }>();
  for (const row of rows) {
    const key = `${row.method} ${row.path}`;
    const current = totals.get(key) ?? { all: 0, errors: 0 };
    const samples = num(row, 'samples');
    current.all += samples;
    if (Number(row.status) >= 400) current.errors += samples;
    totals.set(key, current);
  }
  return new Map([...totals].map(([key, value]) => [key, value.all ? value.errors / value.all : 0]));
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  if (options === 'help') {
    console.log(USAGE);
    return;
  }
  const [beforeEndpoints, afterEndpoints, beforeStatuses, afterStatuses, beforeStages, afterStages, beforeThrottle, afterThrottle] = await Promise.all([
    endpointRows(options, options.before), endpointRows(options, options.after),
    statusRows(options, options.before), statusRows(options, options.after),
    stageRows(options, options.before), stageRows(options, options.after),
    throttleRows(options, options.before), throttleRows(options, options.after),
  ]);
  const beforeByEndpoint = new Map(beforeEndpoints.map((row) => [`${row.method} ${row.path}`, row]));
  const afterByEndpoint = new Map(afterEndpoints.map((row) => [`${row.method} ${row.path}`, row]));
  const beforeErrors = errorRates(beforeStatuses);
  const afterErrors = errorRates(afterStatuses);
  console.log(`\nEndpoint comparison: ${options.before.label} -> ${options.after.label}`);
  for (const key of new Set([...beforeByEndpoint.keys(), ...afterByEndpoint.keys()])) {
    const before = beforeByEndpoint.get(key);
    const after = afterByEndpoint.get(key);
    const enough = num(before ?? {}, 'samples') >= options.minSamples && num(after ?? {}, 'samples') >= options.minSamples;
    if (!enough) {
      console.log(`${key}: insufficient samples (${num(before ?? {}, 'samples')} -> ${num(after ?? {}, 'samples')}; need ${options.minSamples} each)`);
      continue;
    }
    console.log(`${key}: p50 ${percentDelta(num(before!, 'p50_ms'), num(after!, 'p50_ms'))}, p95 ${percentDelta(num(before!, 'p95_ms'), num(after!, 'p95_ms'))}, p99 ${percentDelta(num(before!, 'p99_ms'), num(after!, 'p99_ms'))}, error rate ${((beforeErrors.get(key) ?? 0) * 100).toFixed(2)}% -> ${((afterErrors.get(key) ?? 0) * 100).toFixed(2)}%`);
  }
  const beforeStageMap = new Map(beforeStages.map((row) => [`${row.stage}/${row.outcome}`, row]));
  const afterStageMap = new Map(afterStages.map((row) => [`${row.stage}/${row.outcome}`, row]));
  console.log('\nStage p95 deltas:');
  for (const key of new Set([...beforeStageMap.keys(), ...afterStageMap.keys()])) {
    const before = beforeStageMap.get(key);
    const after = afterStageMap.get(key);
    if (num(before ?? {}, 'samples') < options.minSamples || num(after ?? {}, 'samples') < options.minSamples) continue;
    console.log(`${key}: ${percentDelta(num(before!, 'p95_ms'), num(after!, 'p95_ms'))}`);
  }
  const share = (rows: Row[]) => {
    const counts = new Map(rows.map((row) => [String(row.metric), num(row, 'samples')]));
    const throttled = counts.get('search_throttled') ?? 0;
    const completed = counts.get('search') ?? 0;
    return throttled + completed ? throttled / (throttled + completed) : 0;
  };
  console.log(`\nThrottle share: ${(share(beforeThrottle) * 100).toFixed(2)}% -> ${(share(afterThrottle) * 100).toFixed(2)}%`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
