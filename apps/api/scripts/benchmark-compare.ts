#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type TargetName = 'api' | 'hono';

interface Target {
  name: TargetName;
  baseUrl: string;
  token: string;
}

interface Sample {
  caseName: string;
  target: TargetName;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  elapsedMs: number;
  bytes: number;
  serverTookMs: number | null;
  cfCacheStatus: string | null;
  cfRay: string | null;
  error: string | null;
}

interface SearchRun {
  caseName: string;
  target: TargetName;
  query: string;
  elapsedMs: number;
  serverTookMs: number | null;
  body: any;
}

const startedAt = new Date();
const runId =
  process.env.BENCH_RUN_ID ??
  `bench-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const config = {
  spaceName: process.env.BENCH_SPACE_NAME ?? 'comparision',
  iterations: intEnv('BENCH_ITERATIONS', 7),
  warmups: intEnv('BENCH_WARMUPS', 2),
  ingestionBatches: intEnv('BENCH_INGESTION_BATCHES', 1),
  pollIntervalMs: intEnv('BENCH_POLL_INTERVAL_MS', 2500),
  jobTimeoutMs: intEnv('BENCH_JOB_TIMEOUT_MS', 10 * 60_000),
  searchScenarioPauseMs: intEnv('BENCH_SEARCH_SCENARIO_PAUSE_MS', 0),
  outputDir: resolveOutputDir(process.env.BENCH_OUTPUT_DIR ?? 'performace bench'),
  skipIngestion: boolEnv('BENCH_SKIP_INGESTION', false),
  includeConversation: boolEnv('BENCH_INCLUDE_CONVERSATION', false),
};

const targets: Target[] = [
  {
    name: 'api',
    baseUrl: trimSlash(process.env.CROSMOS_API_BASE_URL ?? 'https://api.crosmos.dev'),
    token: mustEnv('CROSMOS_API_TOKEN'),
  },
  {
    name: 'hono',
    baseUrl: trimSlash(process.env.CROSMOS_HONO_BASE_URL ?? 'https://hono.crosmos.dev'),
    token: mustEnv('CROSMOS_HONO_TOKEN'),
  },
];

const samples: Sample[] = [];
const searchRuns: SearchRun[] = [];
const artifacts: Record<string, any> = {
  runId,
  startedAt: startedAt.toISOString(),
  config: {
    ...config,
    targets: targets.map(({ name, baseUrl }) => ({ name, baseUrl })),
  },
  endpointInventory: {},
  ingestedSourceIds: { api: [], hono: [] },
  spaces: {},
  jobs: [],
  summaries: {},
  searchDrift: [],
};

async function main() {
  await mkdir(config.outputDir, { recursive: true });

  console.log(`benchmark run: ${runId}`);
  console.log(`space name: ${config.spaceName}`);

  await inventoryOpenApi();
  await benchmarkUnauthenticated();
  await benchmarkAuthenticatedLightReads();

  const spaces = await resolveSpaces();
  artifacts.spaces = spaces;

  await benchmarkSpaceAndSourceReads(spaces);

  if (!config.skipIngestion) {
    await benchmarkIngestion(spaces);
    await benchmarkCreatedSourceReads();
  }

  await benchmarkRetrieval(spaces);

  artifacts.summaries = summarize(samples);
  artifacts.searchDrift = compareSearchRuns(searchRuns);

  const jsonPath = join(config.outputDir, `${runId}.json`);
  const csvPath = join(config.outputDir, `${runId}.csv`);
  const htmlPath = join(config.outputDir, `${runId}.html`);
  const latestHtmlPath = join(config.outputDir, 'index.html');
  const result = { ...artifacts, samples, searchRuns };
  const html = renderHtmlReport(result);
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await writeFile(csvPath, toCsv(samples));
  await writeFile(htmlPath, html);
  await writeFile(latestHtmlPath, html);

  printSummary();
  console.log(`json: ${jsonPath}`);
  console.log(`csv:  ${csvPath}`);
  console.log(`html: ${htmlPath}`);
  console.log(`open latest report: ${latestHtmlPath}`);
}

async function inventoryOpenApi() {
  const docs: Record<TargetName, any> = {} as Record<TargetName, any>;
  for (const target of targets) {
    const { body } = await timedJson(target, 'openapi.cached', 'GET', '/openapi.json', {
      auth: false,
      record: false,
    });
    docs[target.name] = body;
  }

  const endpointSets = Object.fromEntries(
    targets.map((target) => [
      target.name,
      Object.entries(docs[target.name]?.paths ?? {}).flatMap(([path, methods]: [string, any]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      ),
    ]),
  ) as Record<TargetName, string[]>;

  const apiSet = new Set(endpointSets.api);
  const honoSet = new Set(endpointSets.hono);
  artifacts.endpointInventory = {
    apiCount: endpointSets.api.length,
    honoCount: endpointSets.hono.length,
    common: endpointSets.api.filter((x) => honoSet.has(x)).sort(),
    apiOnly: endpointSets.api.filter((x) => !honoSet.has(x)).sort(),
    honoOnly: endpointSets.hono.filter((x) => !apiSet.has(x)).sort(),
  };
}

async function benchmarkUnauthenticated() {
  for (const route of [
    { caseName: 'health', path: '/health' },
    { caseName: 'openapi.cached', path: '/openapi.json' },
    { caseName: 'docs.cached', path: '/docs' },
    {
      caseName: 'oauth.metadata',
      path: '/.well-known/oauth-authorization-server',
    },
  ]) {
    await pairedRepeat(route.caseName, 'GET', route.path, {
      auth: false,
      repeats: config.iterations,
      warmups: config.warmups,
    });
  }

  for (const target of targets) {
    for (let i = 0; i < Math.max(2, config.warmups); i++) {
      await timedJson(target, 'openapi.cache_bust', 'GET', `/openapi.json?_bench=${runId}-${i}`, {
        auth: false,
      });
    }
  }
}

async function benchmarkAuthenticatedLightReads() {
  const routes = [
    { caseName: 'auth.me', path: '/api/v1/auth/me' },
    { caseName: 'auth.keys.validate', path: '/api/v1/auth/keys/validate' },
    { caseName: 'auth.keys.list', path: '/api/v1/auth/keys' },
    { caseName: 'orgs.list', path: '/api/v1/orgs' },
  ];

  for (const route of routes) {
    await pairedRepeat(route.caseName, 'GET', route.path, {
      repeats: config.iterations,
      warmups: config.warmups,
    });
  }
}

async function resolveSpaces() {
  const out: Record<TargetName, any> = {} as Record<TargetName, any>;
  for (const target of targets) {
    const path = `/api/v1/spaces?name=${encodeURIComponent(config.spaceName)}`;
    const { body } = await timedJson(target, 'spaces.resolve_by_name', 'GET', path, {
      record: false,
    });
    const space = body?.spaces?.[0];
    if (!space?.id) {
      throw new Error(
        `${target.name}: space "${config.spaceName}" not found via ${path}; got ${JSON.stringify(body)}`,
      );
    }
    out[target.name] = space;
  }
  return out;
}

async function benchmarkSpaceAndSourceReads(spaces: Record<TargetName, any>) {
  await pairedRepeat('spaces.list', 'GET', '/api/v1/spaces', {
    repeats: config.iterations,
    warmups: config.warmups,
  });

  for (const target of targets) {
    const spaceId = spaces[target.name].id;
    for (let i = -config.warmups; i < config.iterations; i++) {
      await timedJson(target, 'spaces.get.cached_gate', 'GET', `/api/v1/spaces/${spaceId}`, {
        record: i >= 0,
      });
      await timedJson(
        target,
        'sources.list.by_space',
        'GET',
        `/api/v1/sources?space_id=${spaceId}&limit=50`,
        { record: i >= 0 },
      );
    }
  }
}

async function benchmarkIngestion(spaces: Record<TargetName, any>) {
  for (let batch = 0; batch < config.ingestionBatches; batch++) {
    const batchId = `${runId}-${batch}`;
    const fixture = ingestionFixture(batchId);
    const conversation = conversationFixture(batchId);

    const createdJobs: Array<{ target: Target; jobId: string; batchId: string; kind: string }> = [];

    for (const target of targets) {
      const spaceId = spaces[target.name].id;
      const { body } = await timedJson(target, 'ingestion.sources.enqueue', 'POST', '/api/v1/sources', {
        body: { space_id: spaceId, sources: fixture },
      });
      if (body?.job_id) {
        createdJobs.push({ target, jobId: body.job_id, batchId, kind: 'sources' });
      }
      if (Array.isArray(body?.source_ids)) {
        artifacts.ingestedSourceIds[target.name].push(...body.source_ids);
      }
    }

    if (config.includeConversation) {
      for (const target of targets) {
        const spaceId = spaces[target.name].id;
        const { body } = await timedJson(
          target,
          'ingestion.conversation.enqueue',
          'POST',
          '/api/v1/conversations',
          {
            body: { space_id: spaceId, ...conversation },
          },
        );
        if (body?.job_id) {
          createdJobs.push({ target, jobId: body.job_id, batchId, kind: 'conversation' });
        }
      }
    }

    for (const job of createdJobs) {
      const result = await pollJob(job.target, job.jobId, job.kind);
      artifacts.jobs.push({ ...job, target: job.target.name, ...result });
    }
  }
}

async function benchmarkCreatedSourceReads() {
  for (const target of targets) {
    const sourceIds = artifacts.ingestedSourceIds[target.name] as string[];
    for (const sourceId of sourceIds.slice(0, 3)) {
      for (let i = -config.warmups; i < config.iterations; i++) {
        await timedJson(target, 'sources.get.created', 'GET', `/api/v1/sources/${sourceId}`, {
          record: i >= 0,
        });
      }
    }
  }
}

async function benchmarkRetrieval(spaces: Record<TargetName, any>) {
  const scenarios = [
    {
      caseName: 'search.exact.rerank_on',
      query: 'What drink does Aria prefer during architecture reviews?',
      body: { limit: 5, rerank: true, graph: true, include_source: true },
    },
    {
      caseName: 'search.semantic.rerank_on',
      query: 'Which database region is mentioned for the worker migration?',
      body: { limit: 5, rerank: true, graph: true, include_source: true },
    },
    {
      caseName: 'search.low_latency.rerank_off',
      query: 'What is the preferred cache warmup route?',
      body: { limit: 5, rerank: false, graph: false, include_source: false },
    },
  ];

  for (const scenario of scenarios) {
    for (const target of targets) {
      const spaceId = spaces[target.name].id;
      for (let i = -config.warmups; i < config.iterations; i++) {
        const { body, sample } = await timedJson(
          target,
          scenario.caseName,
          'POST',
          '/api/v1/search',
          {
            body: {
              space_id: spaceId,
              query: scenario.query,
              ...scenario.body,
            },
            record: i >= 0,
          },
        );
        if (i >= 0 && sample.ok) {
          searchRuns.push({
            caseName: scenario.caseName,
            target: target.name,
            query: scenario.query,
            elapsedMs: sample.elapsedMs,
            serverTookMs: sample.serverTookMs,
            body,
          });
        }
      }
    }
    if (config.searchScenarioPauseMs > 0) {
      await sleep(config.searchScenarioPauseMs);
    }
  }
}

async function pairedRepeat(
  caseName: string,
  method: string,
  path: string,
  opts: { repeats: number; warmups: number; auth?: boolean },
) {
  for (const target of targets) {
    for (let i = -opts.warmups; i < opts.repeats; i++) {
      await timedJson(target, caseName, method, path, {
        auth: opts.auth,
        record: i >= 0,
      });
    }
  }
}

async function pollJob(target: Target, jobId: string, kind: string) {
  const started = performance.now();
  let polls = 0;
  let lastBody: any = null;
  while (performance.now() - started < config.jobTimeoutMs) {
    polls++;
    const { body } = await timedJson(target, `jobs.poll.${kind}`, 'GET', `/api/v1/jobs/${jobId}`);
    lastBody = body;
    if (['completed', 'partial', 'failed', 'cancelled'].includes(body?.status)) {
      return {
        jobId,
        kind,
        polls,
        status: body.status,
        wallMs: performance.now() - started,
        result: body.result ?? null,
        errorMessage: body.error_message ?? null,
      };
    }
    await sleep(config.pollIntervalMs);
  }
  return {
    jobId,
    kind,
    polls,
    status: 'timeout',
    wallMs: performance.now() - started,
    result: lastBody?.result ?? null,
    errorMessage: lastBody?.error_message ?? null,
  };
}

async function timedJson(
  target: Target,
  caseName: string,
  method: string,
  path: string,
  opts: { body?: any; auth?: boolean; record?: boolean } = {},
): Promise<{ body: any; sample: Sample }> {
  const headers = new Headers({
    Accept: 'application/json',
    'User-Agent': `crosmos-benchmark/${runId}`,
  });
  if (opts.auth ?? true) headers.set('Authorization', `Bearer ${target.token}`);
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');

  const url = `${target.baseUrl}${path}`;
  const t0 = performance.now();
  let status = 0;
  let ok = false;
  let text = '';
  let responseHeaders = new Headers();
  let error: string | null = null;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    responseHeaders = res.headers;
    status = res.status;
    ok = res.ok;
    text = await res.text();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const elapsedMs = performance.now() - t0;
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }
  }

  if (!error && !ok) {
    error = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const sample: Sample = {
    caseName,
    target: target.name,
    method,
    path: redactPath(path),
    status,
    ok,
    elapsedMs,
    bytes: text.length,
    serverTookMs: typeof body?.took_ms === 'number' ? body.took_ms : null,
    cfCacheStatus: responseHeaders.get('cf-cache-status'),
    cfRay: responseHeaders.get('cf-ray'),
    error: error ? error.slice(0, 500) : null,
  };
  if (opts.record ?? true) samples.push(sample);
  return { body, sample };
}

function ingestionFixture(batchId: string) {
  return [
    {
      content_type: 'text',
      sequence: 0,
      meta: { bench_run_id: batchId, topic: 'preference' },
      content:
        `Benchmark ${batchId}: Aria prefers black coffee during architecture reviews. ` +
        'She usually asks the team to warm /api/v1/spaces before retrieval tests.',
    },
    {
      content_type: 'text',
      sequence: 1,
      meta: { bench_run_id: batchId, topic: 'infrastructure' },
      content:
        `Benchmark ${batchId}: the worker migration note says the database region is Singapore ` +
        'while the original monolith database is in the United States.',
    },
    {
      content_type: 'text',
      sequence: 2,
      meta: { bench_run_id: batchId, topic: 'travel' },
      content:
        `Benchmark ${batchId}: Mira visited Pune in February and later compared latency from India.`,
    },
  ];
}

function conversationFixture(batchId: string) {
  return {
    session_id: `bench-session-${batchId}`,
    session_date: new Date().toISOString(),
    meta: { bench_run_id: batchId, topic: 'conversation' },
    messages: [
      { role: 'user', content: `Benchmark ${batchId}: where should we cache warmups happen?` },
      { role: 'assistant', content: 'Warm /api/v1/spaces and /api/v1/search gate lookups first.' },
      { role: 'user', content: 'What should we compare after ingestion?' },
      { role: 'assistant', content: 'Compare retrieval latency, returned content, and score drift.' },
    ],
  };
}

function compareSearchRuns(runs: SearchRun[]) {
  const out = [];
  const keys = [...new Set(runs.map((run) => `${run.caseName}\n${run.query}`))];
  for (const key of keys) {
    const [caseName, query] = key.split('\n');
    const api = firstRun(runs, 'api', caseName, query);
    const hono = firstRun(runs, 'hono', caseName, query);
    if (!api || !hono) continue;

    const apiCandidates = api.body?.candidates ?? [];
    const honoCandidates = hono.body?.candidates ?? [];
    const ranks = Array.from({ length: Math.max(apiCandidates.length, honoCandidates.length) }).map(
      (_, index) => {
        const a = apiCandidates[index];
        const h = honoCandidates[index];
        return {
          rank: index + 1,
          apiScore: numberOrNull(a?.score),
          honoScore: numberOrNull(h?.score),
          scoreDelta:
            typeof a?.score === 'number' && typeof h?.score === 'number'
              ? h.score - a.score
              : null,
          sameContent: normalizeCandidate(a) === normalizeCandidate(h),
          apiContent: preview(a?.content),
          honoContent: preview(h?.content),
        };
      },
    );

    out.push({
      caseName,
      query,
      apiElapsedMs: api.elapsedMs,
      honoElapsedMs: hono.elapsedMs,
      apiServerTookMs: api.serverTookMs,
      honoServerTookMs: hono.serverTookMs,
      apiTotal: api.body?.total ?? null,
      honoTotal: hono.body?.total ?? null,
      topContentSame: ranks[0]?.sameContent ?? null,
      ranks,
    });
  }
  return out;
}

function firstRun(runs: SearchRun[], target: TargetName, caseName: string, query: string) {
  return runs.find((run) => run.target === target && run.caseName === caseName && run.query === query);
}

function summarize(rows: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const row of rows.filter((r) => r.ok)) {
    const key = `${row.caseName}::${row.target}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return Object.fromEntries(
    [...groups.entries()].map(([key, group]) => {
      const [caseName, target] = key.split('::');
      const elapsed = group.map((r) => r.elapsedMs).sort((a, b) => a - b);
      const server = group
        .map((r) => r.serverTookMs)
        .filter((x): x is number => typeof x === 'number')
        .sort((a, b) => a - b);
      return [
        key,
        {
          caseName,
          target,
          count: group.length,
          statusCounts: countBy(group.map((r) => String(r.status))),
          elapsedMs: stats(elapsed),
          serverTookMs: server.length ? stats(server) : null,
          cfCacheStatus: countBy(group.map((r) => r.cfCacheStatus ?? 'none')),
        },
      ];
    }),
  );
}

function printSummary() {
  const summaries = artifacts.summaries as Record<string, any>;
  const cases = [...new Set(Object.values(summaries).map((s: any) => s.caseName))].sort();
  console.log('\ncase,target,count,p50_ms,p95_ms,mean_ms,server_p50_ms');
  for (const caseName of cases) {
    for (const target of ['api', 'hono']) {
      const row = summaries[`${caseName}::${target}`];
      if (!row) continue;
      console.log(
        [
          caseName,
          target,
          row.count,
          round(row.elapsedMs.p50),
          round(row.elapsedMs.p95),
          round(row.elapsedMs.mean),
          row.serverTookMs ? round(row.serverTookMs.p50) : '',
        ].join(','),
      );
    }
  }

  if (artifacts.searchDrift.length) {
    console.log('\nsearch drift');
    for (const drift of artifacts.searchDrift) {
      console.log(
        `${drift.caseName}: top_same=${drift.topContentSame} api_total=${drift.apiTotal} hono_total=${drift.honoTotal}`,
      );
    }
  }
}

function toCsv(rows: Sample[]) {
  const header = [
    'caseName',
    'target',
    'method',
    'path',
    'status',
    'ok',
    'elapsedMs',
    'bytes',
    'serverTookMs',
    'cfCacheStatus',
    'cfRay',
    'error',
  ];
  return [
    header.join(','),
    ...rows.map((row) =>
      header
        .map((key) => csvCell((row as any)[key] === null ? '' : (row as any)[key]))
        .join(','),
    ),
  ].join('\n');
}

function renderHtmlReport(result: any) {
  const summaries = result.summaries as Record<string, any>;
  const cases = [...new Set(Object.values(summaries).map((s: any) => s.caseName))].sort();
  const maxP50 = Math.max(
    1,
    ...Object.values(summaries)
      .map((s: any) => s.elapsedMs?.p50)
      .filter((x: unknown): x is number => typeof x === 'number'),
  );
  const failedSamples = (result.samples as Sample[]).filter((sample) => !sample.ok);
  const jobs = result.jobs ?? [];
  const drift = result.searchDrift ?? [];
  const endpointInventory = result.endpointInventory ?? {};

  const latencyRows = cases
    .map((caseName) => {
      const api = summaries[`${caseName}::api`];
      const hono = summaries[`${caseName}::hono`];
      const apiP50 = api?.elapsedMs?.p50 ?? null;
      const honoP50 = hono?.elapsedMs?.p50 ?? null;
      const winner =
        typeof apiP50 === 'number' && typeof honoP50 === 'number'
          ? apiP50 <= honoP50
            ? 'api'
            : 'hono'
          : typeof apiP50 === 'number'
            ? 'api only'
            : typeof honoP50 === 'number'
              ? 'hono only'
              : '';
      const delta =
        typeof apiP50 === 'number' && typeof honoP50 === 'number' ? honoP50 - apiP50 : null;
      return `<tr>
        <td>${escapeHtml(caseName)}</td>
        <td class="${winner === 'api' ? 'winner' : ''}">${ms(apiP50)}${bar(apiP50, maxP50)}</td>
        <td class="${winner === 'hono' ? 'winner' : ''}">${ms(honoP50)}${bar(honoP50, maxP50)}</td>
        <td>${ms(delta, true)}</td>
        <td>${escapeHtml(winner)}</td>
        <td>${escapeHtml(String(api?.count ?? ''))}</td>
        <td>${escapeHtml(String(hono?.count ?? ''))}</td>
      </tr>`;
    })
    .join('');

  const jobRows = jobs.length
    ? jobs
        .map(
          (job: any) => `<tr>
            <td>${escapeHtml(job.target)}</td>
            <td>${escapeHtml(job.kind)}</td>
            <td>${escapeHtml(job.status)}</td>
            <td>${ms(job.wallMs)}</td>
            <td>${escapeHtml(String(job.polls ?? ''))}</td>
            <td>${escapeHtml(String(job.result?.memory_count ?? ''))}</td>
            <td>${escapeHtml(String(job.result?.entity_count ?? ''))}</td>
            <td>${escapeHtml(String(job.result?.edge_count ?? ''))}</td>
            <td>${escapeHtml(String(job.result?.tokens_used ?? ''))}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="9" class="muted">No ingestion jobs in this run.</td></tr>`;

  const driftRows = drift.length
    ? drift
        .map((item: any) => {
          const rankRows = (item.ranks ?? [])
            .map(
              (rank: any) => `<tr>
                <td>${escapeHtml(item.caseName)}</td>
                <td>${escapeHtml(String(rank.rank))}</td>
                <td>${escapeHtml(String(rank.sameContent))}</td>
                <td>${num(rank.apiScore)}</td>
                <td>${num(rank.honoScore)}</td>
                <td>${num(rank.scoreDelta)}</td>
                <td>${escapeHtml(rank.apiContent ?? '')}</td>
                <td>${escapeHtml(rank.honoContent ?? '')}</td>
              </tr>`,
            )
            .join('');
          return rankRows;
        })
        .join('')
    : `<tr><td colspan="8" class="muted">No paired successful search results to compare.</td></tr>`;

  const failureRows = failedSamples.length
    ? failedSamples
        .slice(0, 50)
        .map(
          (sample) => `<tr>
            <td>${escapeHtml(sample.caseName)}</td>
            <td>${escapeHtml(sample.target)}</td>
            <td>${escapeHtml(String(sample.status))}</td>
            <td>${escapeHtml(sample.path)}</td>
            <td>${escapeHtml(sample.error ?? '')}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="5" class="muted">No failed samples.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crosmos API Performance Bench</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #1b1f24;
      --muted: #667085;
      --line: #d9dee7;
      --api: #3563e9;
      --hono: #15986a;
      --bad: #b42318;
      --good-bg: #e7f7ef;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 4px; font-size: 28px; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    .muted { color: var(--muted); }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; }
    th { background: #eef1f6; font-size: 12px; color: #394150; }
    tr:last-child td { border-bottom: 0; }
    .winner { background: var(--good-bg); font-weight: 700; }
    .bar { height: 7px; background: #d8deeb; border-radius: 999px; margin-top: 5px; overflow: hidden; }
    .bar > span { display: block; height: 100%; border-radius: inherit; background: #697586; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    code { background: #eef1f6; padding: 2px 5px; border-radius: 4px; }
    .bad { color: var(--bad); }
    .scroll { overflow-x: auto; }
    @media (max-width: 900px) {
      main { padding: 18px; }
      .cards, .split { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Crosmos API Performance Bench</h1>
    <div class="muted">Run <code>${escapeHtml(result.runId)}</code> at ${escapeHtml(result.startedAt)}</div>

    <section class="cards">
      <div class="card"><div class="label">Measured Cases</div><div class="value">${cases.length}</div></div>
      <div class="card"><div class="label">Failed Samples</div><div class="value ${failedSamples.length ? 'bad' : ''}">${failedSamples.length}</div></div>
      <div class="card"><div class="label">API Endpoints</div><div class="value">${escapeHtml(String(endpointInventory.apiCount ?? ''))}</div></div>
      <div class="card"><div class="label">Hono Endpoints</div><div class="value">${escapeHtml(String(endpointInventory.honoCount ?? ''))}</div></div>
    </section>

    <h2>Latency Comparison</h2>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>api p50</th>
            <th>hono p50</th>
            <th>hono - api</th>
            <th>Faster</th>
            <th>api n</th>
            <th>hono n</th>
          </tr>
        </thead>
        <tbody>${latencyRows}</tbody>
      </table>
    </div>

    <h2>Ingestion Jobs</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>Target</th><th>Kind</th><th>Status</th><th>Wall time</th><th>Polls</th><th>Memories</th><th>Entities</th><th>Edges</th><th>Tokens</th></tr></thead>
        <tbody>${jobRows}</tbody>
      </table>
    </div>

    <h2>Search Score Drift</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>Case</th><th>Rank</th><th>Same content</th><th>api score</th><th>hono score</th><th>Delta</th><th>api content</th><th>hono content</th></tr></thead>
        <tbody>${driftRows}</tbody>
      </table>
    </div>

    <h2>Endpoint Inventory</h2>
    <div class="split">
      <div>
        <h3>API Only</h3>
        <table><tbody>${listRows(endpointInventory.apiOnly ?? [])}</tbody></table>
      </div>
      <div>
        <h3>Hono Only</h3>
        <table><tbody>${listRows(endpointInventory.honoOnly ?? [])}</tbody></table>
      </div>
    </div>

    <h2>Failed Samples</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>Case</th><th>Target</th><th>Status</th><th>Path</th><th>Error</th></tr></thead>
        <tbody>${failureRows}</tbody>
      </table>
    </div>
  </main>
</body>
</html>`;
}

function bar(value: number | null, max: number) {
  if (typeof value !== 'number') return '';
  const width = Math.max(2, Math.min(100, (value / max) * 100));
  return `<div class="bar"><span style="width:${width.toFixed(1)}%"></span></div>`;
}

function listRows(items: string[]) {
  if (!items.length) return `<tr><td class="muted">None</td></tr>`;
  return items.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`).join('');
}

function ms(value: number | null, signed = false) {
  if (typeof value !== 'number') return '';
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(1)} ms`;
}

function num(value: number | null) {
  return typeof value === 'number' ? value.toPrecision(8) : '';
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stats(xs: number[]) {
  return {
    min: xs[0],
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    max: xs[xs.length - 1],
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

function percentile(xs: number[], p: number) {
  if (xs.length === 0) return null;
  const index = Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1);
  return xs[index];
}

function countBy(xs: string[]) {
  return xs.reduce<Record<string, number>>((acc, x) => {
    acc[x] = (acc[x] ?? 0) + 1;
    return acc;
  }, {});
}

function csvCell(value: unknown) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function redactPath(path: string) {
  return path.replace(/([?&](?:token|key|authorization)=)[^&]+/gi, '$1[redacted]');
}

function normalizeCandidate(candidate: any) {
  return String(candidate?.content ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function preview(value: unknown) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' ? value : null;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function resolveOutputDir(value: string) {
  return isAbsolute(value) ? value : join(repoRoot, value);
}

function round(value: number | null) {
  return typeof value === 'number' ? value.toFixed(1) : '';
}

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function intEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mustEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
