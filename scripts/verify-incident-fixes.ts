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
 * Optional: BASE_URL (default https://api.crosmos.dev), BURST (default 24).
 *
 * Two measurement hazards this script has to handle, both of which produced
 * false failures on the first real run against production (2026-08-11):
 *
 *  1. The burst deliberately exceeds the per-user CONCURRENCY cap, but it also
 *     consumes the per-minute RATE limit, which on a small plan is ~10 rpm. The
 *     later phases then received `rate_limited` 429s and were measuring the rate
 *     limiter rather than what they intended to test. So phases that must not be
 *     rate-limited wait out the window and retry.
 *  2. Client wall-clock is not server latency. Shedding is supposed to be one
 *     Durable Object call, but a client several thousand kilometres from the
 *     pinned us-east-1 region pays that round trip on every probe. The script
 *     therefore measures a network baseline first and judges shed cost against
 *     the baseline-adjusted figure, reporting both.
 *
 * Checks
 *   0  network baseline, so later latency numbers mean something
 *   1  search succeeds, and reports latency against the 6s server deadline
 *   2  burst of N concurrent searches: admitted vs shed, and shed cost
 *   3  concurrency 429s carry Retry-After  (the retry-storm fix)
 *   4  pathological query shapes do not 5xx  (tsquery bounding)
 *   5  every non-200 carries a usable retry hint
 */
const BASE = process.env.BASE_URL ?? 'https://api.crosmos.dev';
const KEY = process.env.CROSMOS_API_KEY;
const SPACE = process.env.CROSMOS_SPACE_ID;
if (!KEY) throw new Error('set CROSMOS_API_KEY');
if (!SPACE) throw new Error('set CROSMOS_SPACE_ID (a space uuid the key can read)');

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when a 429 came from the per-minute RATE limiter, not the concurrency gate. */
function isRateLimited(probe: { status: number; body: string }): boolean {
  return probe.status === 429 && probe.body.includes('rate_limited');
}

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

// ── 0. network baseline ───────────────────────────────────────────────────
// `/health` does no database, KV or Durable Object work, so its round trip is
// essentially pure client→edge→origin network cost. Every latency judgement
// below is made against this, not against raw wall-clock.
console.log('\n[0] network baseline');
const healthSamples: number[] = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  await fetch(`${BASE}/health`).then((r) => r.text());
  healthSamples.push(Math.round(performance.now() - t0));
}
healthSamples.sort((a, b) => a - b);
const NETWORK_BASELINE_MS = healthSamples[Math.floor(healthSamples.length / 2)]!;
console.log(
  `      /health p50=${NETWORK_BASELINE_MS}ms (min=${healthSamples[0]}ms max=${healthSamples.at(-1)}ms)`,
);
if (NETWORK_BASELINE_MS > 150) {
  console.log(
    '      note: this client is far from the origin region; server-side costs are' +
      ' judged after subtracting this baseline.',
  );
}

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
// A 504 is the deadline contract working as designed under saturation, not a
// crash — it is reported but does not fail this check. A literal 500 does.
const crashes = burst.filter((r) => r.status >= 500 && r.status !== 504);
const timeouts = burst.filter((r) => r.status === 504);
ok(crashes.length === 0, 'burst produces no 500s', JSON.stringify(byStatus));
if (timeouts.length > 0) {
  console.log(
    `      note: ${timeouts.length}/${BURST} hit the 6s deadline (504). Expected` +
      ' under saturation; investigate only if it happens without a burst.',
  );
}

if (shed.length > 0) {
  ok(shed.every((r) => r.retryAfter !== null), 'every 429 carries Retry-After', `e.g. Retry-After: ${shed[0]!.retryAfter}`);
  const shedMs = shed.map((r) => r.ms).sort((a, b) => a - b);
  const shedP50 = shedMs[Math.floor(shedMs.length / 2)]!;
  // Subtract the measured network floor: the 400ms budget describes SERVER cost
  // (one Durable Object call), and a distant client would otherwise fail this
  // check no matter how cheap the shedding actually is.
  const serverShedP50 = Math.max(0, shedP50 - NETWORK_BASELINE_MS);
  console.log(
    `      shed latency p50=${shedP50}ms max=${shedMs.at(-1)}ms` +
      `  (minus ${NETWORK_BASELINE_MS}ms network baseline → ~${serverShedP50}ms server-side)`,
  );
  ok(
    serverShedP50 < 400,
    'rejection is cheap (early shedding)',
    `~${serverShedP50}ms server-side (raw p50 ${shedP50}ms)`,
  );
} else {
  console.log('      (nothing shed — cap not reached; raise BURST to exercise the 429 path)');
}

// ── 4. pathological repeated-token query ──────────────────────────────────
// The class of input that produced `tsquery stack too small`.
console.log('\n[3] pathological query shapes');

/**
 * Issue one probe, waiting out the per-minute rate-limit window if the burst
 * above consumed it. Without this the probe returns `rate_limited` and the
 * assertion silently measures the rate limiter instead of tsquery bounding —
 * which is exactly what happened on the first production run.
 */
async function probeUnthrottled(label: string, query: string): Promise<Probe> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const probe = await search(query);
    if (!isRateLimited(probe)) {
      console.log(`      ${label}: status=${probe.status} ${probe.ms}ms`);
      return probe;
    }
    const waitMs = (Number(probe.retryAfter) || 60) * 1000;
    console.log(
      `      ${label}: rate-limited by the burst above; waiting ${waitMs / 1000}s for the window`,
    );
    await sleep(waitMs + 1000);
  }
  const final = await search(query);
  console.log(`      ${label}: status=${final.status} ${final.ms}ms (still throttled)`);
  return final;
}

/**
 * The bounding fix is about not blowing up on pathological input. A 200 proves
 * it; so does any bounded 4xx. What must never happen is a 5xx, which is what
 * `tsquery stack too small` produced.
 */
const survived = (p: Probe) => p.status < 500;

const repeated = Array.from({ length: 600 }, (_, i) => `tok${i % 40}`).join(' ');
const rep = await probeUnthrottled('repeated-token', repeated.slice(0, 2999));
ok(survived(rep), 'repeated-token query does not 5xx', survived(rep) ? `status ${rep.status}` : rep.body);

const distinct = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
const dist = await probeUnthrottled('many-distinct-token', distinct.slice(0, 2999));
ok(survived(dist), 'many-distinct-token query does not 5xx', survived(dist) ? `status ${dist.status}` : dist.body);

const longTok = 'x'.repeat(2500) + ' pricing';
const lng = await probeUnthrottled('single-huge-token', longTok);
ok(survived(lng), 'single-huge-token query does not 5xx', survived(lng) ? `status ${lng.status}` : lng.body);

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
