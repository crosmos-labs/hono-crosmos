#!/usr/bin/env bun
/**
 * Capture / compare `/search` results against a live environment.
 *
 * The retrieval changes in the ingestion-and-retrieval checklist (SQL bounds,
 * the provenance/content split, deadline propagation) are all asserted to be
 * ranking-neutral, and differential unit tests prove that on fixtures. This
 * closes the loop on real data: snapshot before deploying, snapshot after, diff.
 *
 *   CROSMOS_API_KEY=csk_… CROSMOS_SPACE_ID=<uuid> \
 *     bun scripts/search-snapshot.ts capture before.json
 *   # …deploy…
 *   bun scripts/search-snapshot.ts capture after.json
 *   bun scripts/search-snapshot.ts diff before.json after.json
 *
 * Optional: BASE_URL (default https://api.crosmos.dev),
 *           QUERY_FILE (newline-separated queries; defaults to the set below).
 *
 * Requests are issued SERIALLY with a pause, because the per-minute rate limit
 * is small and a burst would turn half the snapshot into 429s.
 */
const BASE = process.env.BASE_URL ?? 'https://api.crosmos.dev';
const KEY = process.env.CROSMOS_API_KEY;
const SPACE = process.env.CROSMOS_SPACE_ID;

const DEFAULT_QUERIES = [
  'what did we discuss about pricing',
  'user preferences',
  'what happened last week',
  'who is working on the project',
  'technical decisions',
  'meeting notes',
];

interface Candidate {
  memory_id: string;
  score: number;
  memory_type: string;
  event_time: string | null;
  source_len: number | null;
}

interface Snapshot {
  captured_at: string;
  base: string;
  results: Record<
    string,
    { status: number; took_ms: number; candidates: Candidate[] } | { error: string }
  >;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function capture(outPath: string): Promise<void> {
  if (!KEY || !SPACE) throw new Error('set CROSMOS_API_KEY and CROSMOS_SPACE_ID');
  const queries = process.env.QUERY_FILE
    ? (await Bun.file(process.env.QUERY_FILE).text())
        .split('\n')
        .map((q) => q.trim())
        .filter(Boolean)
    : DEFAULT_QUERIES;

  const snapshot: Snapshot = {
    captured_at: new Date().toISOString(),
    base: BASE,
    results: {},
  };

  for (const query of queries) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/api/v1/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      // include_source stays true so the provenance/content split is covered.
      body: JSON.stringify({ query, space_id: SPACE, limit: 10, include_source: true }),
    });
    const took = Math.round(performance.now() - t0);

    if (!res.ok) {
      snapshot.results[query] = { error: `${res.status} ${await res.text()}`.slice(0, 200) };
      console.log(`  ${res.status}  ${query}`);
    } else {
      const body = (await res.json()) as {
        candidates: Array<{
          memory_id: string;
          score: number;
          memory_type: string;
          event_time: string | null;
          source?: string | null;
        }>;
      };
      snapshot.results[query] = {
        status: res.status,
        took_ms: took,
        candidates: body.candidates.map((c) => ({
          memory_id: c.memory_id,
          score: c.score,
          memory_type: c.memory_type,
          event_time: c.event_time,
          // The source string can be large; its length is enough to catch a
          // truncation or a wrong-source regression without storing user text.
          source_len: c.source == null ? null : c.source.length,
        })),
      };
      console.log(`  200  ${took}ms  ${body.candidates.length} results  ${query}`);
    }
    // Stay under the per-minute rate limit.
    await sleep(7000);
  }

  await Bun.write(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nwrote ${outPath}`);
}

async function diff(beforePath: string, afterPath: string): Promise<void> {
  const before = (await Bun.file(beforePath).json()) as Snapshot;
  const after = (await Bun.file(afterPath).json()) as Snapshot;

  let identical = 0;
  let changed = 0;
  const notes: string[] = [];

  for (const [query, b] of Object.entries(before.results)) {
    const a = after.results[query];
    if (a === undefined) {
      notes.push(`MISSING after: ${query}`);
      changed++;
      continue;
    }
    if ('error' in b || 'error' in a) {
      notes.push(
        `SKIP (error in a run): ${query} — before=${'error' in b ? b.error : 'ok'} after=${'error' in a ? a.error : 'ok'}`,
      );
      continue;
    }

    const ids = (c: Candidate[]) => c.map((x) => x.memory_id).join(',');
    const scores = (c: Candidate[]) => c.map((x) => x.score.toFixed(6)).join(',');
    const sources = (c: Candidate[]) => c.map((x) => String(x.source_len)).join(',');

    const sameIds = ids(b.candidates) === ids(a.candidates);
    const sameScores = scores(b.candidates) === scores(a.candidates);
    const sameSources = sources(b.candidates) === sources(a.candidates);

    if (sameIds && sameScores && sameSources) {
      identical++;
      console.log(`  SAME   ${query}  (${a.candidates.length} results, ${b.took_ms}ms → ${a.took_ms}ms)`);
    } else {
      changed++;
      console.log(`  DIFF   ${query}`);
      if (!sameIds) {
        console.log(`         ids     before: ${ids(b.candidates)}`);
        console.log(`         ids      after: ${ids(a.candidates)}`);
      }
      if (!sameScores) {
        console.log(`         scores  before: ${scores(b.candidates)}`);
        console.log(`         scores   after: ${scores(a.candidates)}`);
      }
      if (!sameSources) {
        console.log(`         src len before: ${sources(b.candidates)}`);
        console.log(`         src len  after: ${sources(a.candidates)}`);
      }
    }
  }

  for (const n of notes) console.log(`  ${n}`);

  const latency = (s: Snapshot) => {
    const v = Object.values(s.results)
      .filter((r): r is { status: number; took_ms: number; candidates: Candidate[] } => !('error' in r))
      .map((r) => r.took_ms)
      .sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };

  console.log(
    `\n${identical} identical, ${changed} changed` +
      `\nlatency p50: ${latency(before)}ms → ${latency(after)}ms`,
  );
  process.exit(changed > 0 ? 1 : 0);
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'capture' && a) await capture(a);
else if (mode === 'diff' && a && b) await diff(a, b);
else {
  console.log('usage: search-snapshot.ts capture <out.json> | diff <before.json> <after.json>');
  process.exit(2);
}
