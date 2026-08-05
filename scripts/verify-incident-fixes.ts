#!/usr/bin/env bun
/**
 * Post-deploy verification for the 2026-07-25 incident remediation.
 *
 * Exercises the shipped behavior against a live environment and reports what it
 * observes. Read-only apart from the searches it issues, which are ordinary
 * API calls against a space you nominate.
 *
 *   CROSMOS_API_KEY=csk_... CROSMOS_SPACE_ID=<uuid> bun scripts/verify-incident-fixes.ts
 *
 * Optional: BASE_URL (default https://api.crosmos.dev)
 *
 * Checks
 *   1  search succeeds, and reports latency against the 6s server deadline
 *   2  concurrency 429 carries Retry-After  (the retry-storm fix)
 *   3  burst of N concurrent searches: how many are admitted vs shed
 *   4  a pathological repeated-token query does not 500  (tsquery bounding)
 *   5  a long query does not 500                          (tsquery bounding)
 *   6  quota/dependency responses carry the right retry hints, if triggered
 */
const BASE = process.env.BASE_URL ?? 'https://api.crosmos.dev';
const KEY = process.env.CROSMOS_API_KEY;
const SPACE = process.env.CROSMOS_SPACE_ID;
if (!KEY) throw new Error('set CROSMOS_API_KEY');
if (!SPACE) throw new Error('set CROSMOS_SPACE_ID (a space uuid the key can read)');

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

interface Probe {
  status: number;
  ms: number;
  retryAfter: string | null;
  shouldRetry: string | null;
  requestId: string | null;
  body: string;
}

async function search(query: string, extra: Record<string, unknown> = {}): Promise<Probe> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/v1/search`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ query, space_id: SPACE, limit: 5, ...extra }),
  });
  const body = await res.text();
  return {
    status: res.status,
    ms: Math.round(performance.now() - t0),
    retryAfter: res.headers.get('retry-after'),
    shouldRetry: res.headers.get('x-should-retry'),
    requestId: res.headers.get('x-request-id'),
    body: body.slice(0, 200),
  };
}

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${msg}${detail ? `  — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${msg}${detail ? `  — ${detail}` : ''}`);
  }
};

console.log(`\nVerifying ${BASE}\n${'─'.repeat(72)}`);

// ── 1. baseline search ────────────────────────────────────────────────────
console.log('\n[1] baseline search');
const base = await search('what did we discuss about pricing');
console.log(`      status=${base.status} ${base.ms}ms request_id=${base.requestId}`);
ok(base.status === 200, 'search returns 200', base.status === 200 ? '' : base.body);
ok(base.ms < 6000, 'completes inside the 6s server deadline', `${base.ms}ms`);
if (base.status !== 200) {
  console.log(`\n      body: ${base.body}\n      Cannot continue without a working search.`);
  process.exit(1);
}

// ── 2/3. concurrency shedding ─────────────────────────────────────────────
// Fire well past the per-user cap (default 10) at once. Expect some 200s and
// some 429s; every 429 must carry Retry-After, which is the header whose
// absence drove the incident's retry amplification.
const BURST = Number(process.env.BURST ?? 24);
console.log(`\n[2] concurrency burst (${BURST} simultaneous searches)`);
const burst = await Promise.all(
  Array.from({ length: BURST }, (_, i) => search(`burst probe ${i} memory recall`)),
);
const byStatus = burst.reduce<Record<number, number>>((a, r) => {
  a[r.status] = (a[r.status] ?? 0) + 1;
  return a;
}, {});
console.log(`      statuses: ${JSON.stringify(byStatus)}`);
const shed = burst.filter((r) => r.status === 429);
const admitted = burst.filter((r) => r.status === 200);
console.log(
  `      admitted=${admitted.length} shed=${shed.length}` +
    (admitted.length ? `  admitted p50=${admitted.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(admitted.length / 2)]}ms` : ''),
);
ok(burst.every((r) => r.status === 200 || r.status === 429), 'burst produces only 200/429, no 500s', JSON.stringify(byStatus));

if (shed.length > 0) {
  ok(shed.every((r) => r.retryAfter !== null), 'every 429 carries Retry-After', `e.g. Retry-After: ${shed[0]!.retryAfter}`);
  const shedMs = shed.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`      shed latency p50=${shedMs[Math.floor(shedMs.length / 2)]}ms max=${shedMs.at(-1)}ms`);
  ok(shedMs[Math.floor(shedMs.length / 2)]! < 400, 'rejection is cheap (early shedding)', `p50 ${shedMs[Math.floor(shedMs.length / 2)]}ms`);
} else {
  console.log('      (nothing shed — cap not reached; raise BURST to exercise the 429 path)');
}

// ── 4. pathological repeated-token query ──────────────────────────────────
// The class of input that produced `tsquery stack too small`.
console.log('\n[3] pathological query shapes');
const repeated = Array.from({ length: 600 }, (_, i) => `tok${i % 40}`).join(' ');
const rep = await search(repeated.slice(0, 2999));
console.log(`      repeated-token: status=${rep.status} ${rep.ms}ms`);
ok(rep.status === 200, 'repeated-token query does not 500', rep.status === 200 ? '' : rep.body);

const distinct = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
const dist = await search(distinct.slice(0, 2999));
console.log(`      many-distinct-token: status=${dist.status} ${dist.ms}ms`);
ok(dist.status === 200, 'many-distinct-token query does not 500', dist.status === 200 ? '' : dist.body);

const longTok = 'x'.repeat(2500) + ' pricing';
const lng = await search(longTok);
console.log(`      single-huge-token: status=${lng.status} ${lng.ms}ms`);
ok(lng.status === 200, 'single-huge-token query does not 500', lng.status === 200 ? '' : lng.body);

// ── 5. retry hints on whatever non-200s we saw ────────────────────────────
console.log('\n[4] retry hints observed');
const all = [base, ...burst, rep, dist, lng];
const nonOk = all.filter((r) => r.status !== 200);
if (nonOk.length === 0) {
  console.log('      (all requests succeeded — no error hints to inspect)');
} else {
  const seen = new Map<string, Probe>();
  for (const r of nonOk) if (!seen.has(String(r.status))) seen.set(String(r.status), r);
  for (const [status, r] of seen) {
    console.log(`      ${status}: Retry-After=${r.retryAfter ?? '(none)'} x-should-retry=${r.shouldRetry ?? '(unset)'}`);
  }
  ok(
    nonOk.every((r) => r.retryAfter !== null || r.shouldRetry === 'false'),
    'every non-200 carries a retry hint (Retry-After or x-should-retry:false)',
  );
}

console.log(`\n${'─'.repeat(72)}\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
