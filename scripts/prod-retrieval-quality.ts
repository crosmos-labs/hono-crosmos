#!/usr/bin/env bun

/**
 * Focused production retrieval-quality evaluation.
 *
 * Creates an isolated space, ingests a labeled synthetic corpus, then compares
 * the production defaults with rerank/graph/recency/diversity ablations. The
 * API key is read only from CROSMOS_API_KEY and is never printed or persisted.
 */

const BASE_URL = process.env.BASE_URL ?? 'https://api.crosmos.dev';
const API_KEY = process.env.CROSMOS_API_KEY;
if (!API_KEY) throw new Error('set CROSMOS_API_KEY');

const REQUEST_INTERVAL_MS = Number(process.env.QUALITY_REQUEST_INTERVAL_MS ?? 6_500);
const EXISTING_SPACE_ID = process.env.QUALITY_SPACE_ID?.trim() || null;
const SELECTED_VARIANTS = new Set(
  (process.env.QUALITY_VARIANTS ?? 'default,no-rerank,no-graph,no-recency,diversify')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const TOP_K = 10;
const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

type Message = { role: string; content: string };
type Session = { id: string; date: string; messages: Message[] };
type Matcher = { all: string[]; none?: string[] };
type Query = {
  id: string;
  category: string;
  text: string;
  gold: Matcher[];
  stale?: Matcher[];
};
type SearchOptions = {
  rerank?: boolean;
  graph?: boolean;
  diversify?: boolean;
  recency_bias?: number | null;
};
type Candidate = { content: string; score: number; event_time: string | null };

const sessions: Session[] = [
  {
    id: 'cedar-initial',
    date: '2026-01-10T09:00:00Z',
    messages: [{ role: 'user', content: 'Project Cedar Phoenix is led by Alina Rao. It uses MySQL and is planned to go live on September 14, 2026. The internal program code is CP-417.' }],
  },
  {
    id: 'cedar-update',
    date: '2026-04-18T09:00:00Z',
    messages: [{ role: 'user', content: 'Cedar Phoenix update: Omar Haddad replaced Alina Rao as lead. The database changed from MySQL to PostgreSQL, and the go-live moved from September 14 to October 6, 2026.' }],
  },
  {
    id: 'cedar-final',
    date: '2026-07-29T09:00:00Z',
    messages: [{ role: 'user', content: 'Final Cedar Phoenix steering decision: go-live is now October 20, 2026 because compliance review needs two more weeks. Omar Haddad remains the lead and PostgreSQL remains the production database.' }],
  },
  {
    id: 'travel-initial',
    date: '2026-02-02T08:00:00Z',
    messages: [{ role: 'user', content: 'For flights I prefer a window seat, avoid red-eye departures, and follow a vegan diet.' }],
  },
  {
    id: 'travel-update',
    date: '2026-08-03T08:00:00Z',
    messages: [{ role: 'user', content: 'Travel preference update after knee surgery: I now need an aisle seat instead of a window seat. I still avoid red-eye flights. I am vegetarian now, not vegan, and dairy is okay.' }],
  },
  {
    id: 'allergy-negation',
    date: '2026-06-11T10:00:00Z',
    messages: [{ role: 'user', content: 'I have a severe sesame allergy. I am explicitly not allergic to shellfish or peanuts. Restaurants should avoid sesame oil and tahini.' }],
  },
  {
    id: 'assistant-fact',
    date: '2026-05-04T13:00:00Z',
    messages: [
      { role: 'user', content: 'Can you check the Nova Components supplier record?' },
      { role: 'assistant', content: 'The supplier contact is Dr. Imani Cole and the active contract identifier is NC-778.' },
      { role: 'user', content: 'Great, remember those supplier details.' },
    ],
  },
  {
    id: 'graph-kestrel',
    date: '2026-03-05T11:00:00Z',
    messages: [{ role: 'user', content: 'The Kestrel Relay application depends on the Borealis Ledger service. Its largest customer is Acme Observatory.' }],
  },
  {
    id: 'graph-borealis',
    date: '2026-03-12T11:00:00Z',
    messages: [{ role: 'user', content: 'Borealis Ledger is owned by Lena Ortiz and stores transaction state in the Pulsar Archive database.' }],
  },
  {
    id: 'graph-pulsar',
    date: '2026-03-19T11:00:00Z',
    messages: [{ role: 'user', content: 'Pulsar Archive is hosted in Dublin. Dario Chen performed its most recent encryption-key rotation using change ticket PA-882.' }],
  },
  {
    id: 'book-one',
    date: '2026-01-22T19:00:00Z',
    messages: [{ role: 'user', content: 'I finished reading The Left Hand of Darkness by Ursula K. Le Guin and loved its political anthropology.' }],
  },
  {
    id: 'book-two',
    date: '2026-04-09T19:00:00Z',
    messages: [{ role: 'user', content: 'I read Piranesi by Susanna Clarke in two evenings and especially liked the mysterious architecture.' }],
  },
  {
    id: 'book-three',
    date: '2026-07-15T19:00:00Z',
    messages: [{ role: 'user', content: 'I completed Sea of Tranquility by Emily St. John Mandel; it is the third novel I have finished this year.' }],
  },
  {
    id: 'spanish-preference',
    date: '2026-05-20T18:00:00Z',
    messages: [{ role: 'user', content: 'Mi restaurante favorito en Madrid es Casa Lucero, y siempre pido las croquetas de setas.' }],
  },
  {
    id: 'french-anniversary',
    date: '2026-06-20T18:00:00Z',
    messages: [{ role: 'user', content: 'Notre anniversaire est le 12 novembre. Nous avons réservé une table au restaurant Églantine à Lyon.' }],
  },
  {
    id: 'similar-codes',
    date: '2026-07-01T14:00:00Z',
    messages: [{ role: 'user', content: 'The Zenith invoice code is ZX-4107. The related shipment code is ZX-4170, while the nightly backup label is ZX-4017. These identifiers are different and must not be swapped.' }],
  },
  {
    id: 'meridian-distractor',
    date: '2026-05-25T14:00:00Z',
    messages: [{ role: 'user', content: 'Project Meridian Phoenix is unrelated to Cedar Phoenix. Alina Rao leads Meridian, it uses MySQL, and its release remains September 14, 2026. Meridian code is MP-914.' }],
  },
  {
    id: 'personal-summary',
    date: '2026-08-08T12:00:00Z',
    messages: [{ role: 'user', content: 'For the December Oslo trip I booked the Thon Hotel Opera, reservation OH-2044. I will travel with my sister Mara and plan to visit the Fram Museum.' }],
  },
];

const queries: Query[] = [
  { id: 'temporal-date', category: 'temporal', text: 'What is the current go-live date for Cedar Phoenix?', gold: [{ all: ['cedar phoenix', 'october 20'] }], stale: [{ all: ['cedar phoenix', 'september 14'], none: ['october 20'] }, { all: ['cedar phoenix', 'october 6'], none: ['october 20'] }] },
  { id: 'temporal-lead', category: 'temporal', text: 'Who currently leads Cedar Phoenix?', gold: [{ all: ['cedar phoenix', 'omar haddad'] }], stale: [{ all: ['cedar phoenix', 'alina rao'], none: ['omar haddad'] }] },
  { id: 'temporal-database', category: 'temporal', text: 'Which production database does Cedar Phoenix use now?', gold: [{ all: ['cedar phoenix', 'postgresql'] }], stale: [{ all: ['cedar phoenix', 'mysql'], none: ['postgresql'] }] },
  { id: 'temporal-change', category: 'temporal', text: 'What changed about Cedar Phoenix since the initial plan?', gold: [{ all: ['cedar phoenix', 'october 20'] }, { all: ['cedar phoenix', 'omar haddad'] }, { all: ['cedar phoenix', 'postgresql'] }] },
  { id: 'preference-seat', category: 'knowledge-update', text: 'What kind of airplane seat do I currently need?', gold: [{ all: ['aisle seat'] }], stale: [{ all: ['window seat'], none: ['aisle seat'] }] },
  { id: 'preference-diet', category: 'knowledge-update', text: 'What is my current diet and can I have dairy?', gold: [{ all: ['vegetarian'] }, { all: ['dairy', 'okay'] }], stale: [{ all: ['vegan'], none: ['not vegan'] }] },
  { id: 'negation-allergy', category: 'negation', text: 'Which food am I actually allergic to?', gold: [{ all: ['sesame allergy'] }], stale: [{ all: ['allergic', 'shellfish'], none: ['not allergic'] }, { all: ['allergic', 'peanuts'], none: ['not allergic'] }] },
  { id: 'negation-shellfish', category: 'negation', text: 'Am I allergic to shellfish?', gold: [{ all: ['not allergic', 'shellfish'] }] },
  { id: 'assistant-contact', category: 'assistant-memory', text: 'Who is the Nova Components supplier contact?', gold: [{ all: ['imani cole'] }] },
  { id: 'assistant-contract', category: 'assistant-memory', text: 'What is the active Nova Components contract identifier?', gold: [{ all: ['nc-778'] }] },
  { id: 'graph-owner', category: 'graph', text: 'Who owns the service that Kestrel Relay depends on?', gold: [{ all: ['borealis ledger', 'lena ortiz'] }] },
  { id: 'graph-location', category: 'graph', text: 'Where is the database used by Kestrel Relay\'s dependency hosted?', gold: [{ all: ['pulsar archive', 'dublin'] }] },
  { id: 'graph-rotation', category: 'graph', text: 'Who rotated the encryption key for the database behind Kestrel Relay, and what was the ticket?', gold: [{ all: ['dario chen'] }, { all: ['pa-882'] }] },
  { id: 'aggregate-books', category: 'aggregation', text: 'Which three books have I finished this year?', gold: [{ all: ['left hand of darkness'] }, { all: ['piranesi'] }, { all: ['sea of tranquility'] }] },
  { id: 'multilingual-es-en', category: 'multilingual', text: 'What is my favorite restaurant in Madrid and what do I order there?', gold: [{ all: ['casa lucero'] }, { all: ['mushroom croquettes'] }] },
  { id: 'multilingual-fr-en', category: 'multilingual', text: 'When is our anniversary and where did we reserve dinner?', gold: [{ all: ['november 12'] }, { all: ['églantine'] }] },
  { id: 'exact-invoice', category: 'exact-identifier', text: 'What is the Zenith invoice code?', gold: [{ all: ['invoice', 'zx-4107'] }] },
  { id: 'exact-shipment', category: 'exact-identifier', text: 'What is the Zenith shipment code?', gold: [{ all: ['shipment', 'zx-4170'] }] },
  { id: 'exact-backup', category: 'exact-identifier', text: 'What is the nightly backup label?', gold: [{ all: ['backup', 'zx-4017'] }] },
  { id: 'similar-project', category: 'distractor', text: 'What is the program code for Meridian Phoenix?', gold: [{ all: ['meridian', 'mp-914'] }], stale: [{ all: ['cp-417'] }] },
  { id: 'personal-trip', category: 'single-session', text: 'Summarize my December Oslo travel plans.', gold: [{ all: ['thon hotel opera'] }, { all: ['oh-2044'] }, { all: ['mara'] }, { all: ['fram museum'] }] },
  { id: 'temporal-lead-contrast', category: 'temporal-adversarial', text: 'Is Alina Rao still the lead of Cedar Phoenix?', gold: [{ all: ['omar haddad', 'replaced', 'alina rao'] }], stale: [{ all: ['cedar phoenix', 'led by alina rao'], none: ['omar haddad'] }] },
  { id: 'temporal-database-contrast', category: 'temporal-adversarial', text: 'Does Cedar Phoenix still run MySQL in production?', gold: [{ all: ['changed from mysql to postgresql'] }], stale: [{ all: ['cedar phoenix', 'uses mysql'], none: ['postgresql'] }] },
  { id: 'temporal-date-contrast', category: 'temporal-adversarial', text: 'Is September 14 still the Cedar Phoenix go-live date?', gold: [{ all: ['october 20'] }], stale: [{ all: ['september 14'], none: ['october 20'] }] },
  { id: 'preference-seat-contrast', category: 'knowledge-update-adversarial', text: 'Do I still prefer a window seat?', gold: [{ all: ['aisle seat', 'instead of a window seat'] }], stale: [{ all: ['prefers a window seat'], none: ['aisle'] }] },
  { id: 'preference-diet-contrast', category: 'knowledge-update-adversarial', text: 'Am I still vegan?', gold: [{ all: ['vegetarian now', 'not vegan'] }], stale: [{ all: ['vegan diet'], none: ['not vegan'] }] },
  { id: 'negation-peanuts', category: 'negation', text: 'Do restaurants need to avoid peanuts for me?', gold: [{ all: ['not allergic', 'peanuts'] }] },
  { id: 'assistant-combined', category: 'assistant-memory', text: 'Give me both stored Nova Components supplier details.', gold: [{ all: ['imani cole'] }, { all: ['nc-778'] }] },
  { id: 'graph-owner-chain', category: 'graph', text: 'Name Kestrel Relay\'s dependency and the person who owns it.', gold: [{ all: ['kestrel relay', 'borealis ledger'] }, { all: ['borealis ledger', 'lena ortiz'] }] },
  { id: 'multilingual-es-query', category: 'multilingual', text: '¿Cuál es mi restaurante favorito en Madrid y qué plato pido?', gold: [{ all: ['casa lucero'] }, { all: ['mushroom croquettes'] }] },
  { id: 'multilingual-fr-query', category: 'multilingual', text: 'Quelle est la date de notre anniversaire et où avons-nous réservé?', gold: [{ all: ['november 12'] }, { all: ['églantine'] }] },
  { id: 'exact-reverse-lookup', category: 'exact-identifier', text: 'What does identifier ZX-4170 refer to?', gold: [{ all: ['shipment', 'zx-4170'] }] },
  { id: 'distractor-cedar-code', category: 'distractor', text: 'Give me Cedar Phoenix\'s code, not Meridian Phoenix\'s code.', gold: [{ all: ['cedar phoenix', 'cp-417'] }], stale: [{ all: ['mp-914'] }] },
  { id: 'personal-reservation', category: 'single-session', text: 'What is my Oslo hotel reservation number?', gold: [{ all: ['thon hotel opera', 'oh-2044'] }] },
  { id: 'aggregate-latest-book', category: 'aggregation', text: 'What is the most recent novel I finished this year?', gold: [{ all: ['sea of tranquility'] }] },
  { id: 'unanswerable-crypto', category: 'unanswerable', text: 'What is my favorite cryptocurrency and which hardware wallet do I use?', gold: [] },
  { id: 'unanswerable-blood', category: 'unanswerable', text: 'What is my blood type?', gold: [] },
  { id: 'unanswerable-passport', category: 'unanswerable', text: 'What is my passport number and expiry date?', gold: [] },
  { id: 'unanswerable-phone', category: 'unanswerable', text: 'What is my mobile phone number?', gold: [] },
  { id: 'unanswerable-tax', category: 'unanswerable', text: 'What is my tax identification number?', gold: [] },
  { id: 'unanswerable-pet', category: 'unanswerable', text: 'What is the name of my pet?', gold: [] },
  { id: 'unanswerable-salary', category: 'unanswerable', text: 'What is my current annual salary?', gold: [] },
  { id: 'unanswerable-medication', category: 'unanswerable', text: 'Which prescription medication do I take every morning?', gold: [] },
  { id: 'unanswerable-address', category: 'unanswerable', text: 'What is my home street address?', gold: [] },
  { id: 'unanswerable-emergency', category: 'unanswerable', text: 'Who is my emergency contact and what is their number?', gold: [] },
];

let lastAiRequestAt = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function paceAiRequest(): Promise<void> {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastAiRequestAt);
  if (wait > 0) await sleep(wait);
  lastAiRequestAt = Date.now();
}

async function api(path: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    if (response.status !== 429 || attempt === attempts) return response;
    const retryAfter = Number(response.headers.get('retry-after') ?? '7');
    await sleep(Math.max(1, retryAfter) * 1_000);
  }
  throw new Error('unreachable');
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('en-US').normalize('NFKC');
}

function matches(content: string, matcher: Matcher): boolean {
  const text = normalize(content);
  return matcher.all.every((part) => text.includes(normalize(part)))
    && !(matcher.none ?? []).some((part) => text.includes(normalize(part)));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function evaluate(query: Query, candidates: Candidate[]) {
  const goldRanks = query.gold.map((gold) => {
    const index = candidates.findIndex((candidate) => matches(candidate.content, gold));
    return index < 0 ? null : index + 1;
  });
  const staleRanks = (query.stale ?? []).map((stale) => {
    const index = candidates.findIndex((candidate) => matches(candidate.content, stale));
    return index < 0 ? null : index + 1;
  });
  const presentGold = goldRanks.filter((rank): rank is number => rank !== null);
  const firstGold = presentGold.length > 0 ? Math.min(...presentGold) : null;
  const firstStale = staleRanks.filter((rank): rank is number => rank !== null);

  return {
    coverage: query.gold.length === 0 ? null : presentGold.length / query.gold.length,
    all_facts: query.gold.length > 0 && presentGold.length === query.gold.length,
    top1_relevant: firstGold === 1,
    reciprocal_rank: firstGold === null ? 0 : 1 / firstGold,
    gold_ranks: goldRanks,
    stale_ranks: staleRanks,
    stale_before_fresh:
      firstGold !== null && firstStale.length > 0
        ? Math.min(...firstStale) < firstGold
        : false,
    max_score: candidates[0]?.score ?? null,
    result_count: candidates.length,
  };
}

async function main() {
  const runId = `quality-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const space = EXISTING_SPACE_ID
    ? { id: EXISTING_SPACE_ID }
    : await jsonOrThrow<{ id: string }>(await api('/api/v1/spaces', {
      method: 'POST',
      body: JSON.stringify({
        name: `codex-${runId}`,
        description: 'Temporary labeled Voyage production retrieval evaluation',
        meta: { purpose: 'retrieval-quality-eval', run_id: runId },
      }),
    }));
  console.error(`space=${space.id} sessions=${EXISTING_SPACE_ID ? 0 : sessions.length} queries=${queries.length}`);

  const jobs: string[] = [];
  for (const [index, session] of (EXISTING_SPACE_ID ? [] : sessions).entries()) {
    await paceAiRequest();
    const started = performance.now();
    const result = await jsonOrThrow<{ job_id: string }>(await api('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({
        space_id: space.id,
        session_id: `${runId}-${session.id}`,
        session_date: session.date,
        visibility: 'private',
        meta: { benchmark: 'voyage-quality-v2', category: session.id },
        messages: session.messages,
      }),
    }));
    jobs.push(result.job_id);
    console.error(`ingest ${index + 1}/${sessions.length} ${session.id} ${(performance.now() - started).toFixed(0)}ms`);
  }

  const jobStats: number[] = [];
  for (const [index, jobId] of jobs.entries()) {
    const deadline = Date.now() + 180_000;
    while (true) {
      const job = await jsonOrThrow<{
        status: string;
        error_message: string | null;
        created_at: string;
        completed_at: string | null;
      }>(await api(`/api/v1/jobs/${jobId}`));
      if (['completed', 'partial', 'failed', 'cancelled'].includes(job.status)) {
        if (job.status !== 'completed') {
          throw new Error(`job ${jobId} ended ${job.status}: ${job.error_message ?? ''}`);
        }
        jobStats.push(new Date(job.completed_at!).getTime() - new Date(job.created_at).getTime());
        break;
      }
      if (Date.now() >= deadline) throw new Error(`job ${jobId} timed out`);
      await sleep(1_500);
    }
    console.error(`await ${index + 1}/${jobs.length}`);
  }

  const cases: Array<{ variant: string; query: Query; options: SearchOptions }> = [];
  for (const query of queries) {
    if (SELECTED_VARIANTS.has('default')) cases.push({ variant: 'default', query, options: {} });
    if (SELECTED_VARIANTS.has('no-rerank')) cases.push({ variant: 'no-rerank', query, options: { rerank: false } });
  }
  if (SELECTED_VARIANTS.has('no-graph')) {
    for (const query of queries.filter((item) => item.category === 'graph')) {
      cases.push({ variant: 'no-graph', query, options: { graph: false } });
    }
  }
  if (SELECTED_VARIANTS.has('no-recency')) {
    for (const query of queries.filter((item) => ['temporal', 'knowledge-update'].includes(item.category))) {
      cases.push({ variant: 'no-recency', query, options: { recency_bias: 0 } });
    }
  }
  if (SELECTED_VARIANTS.has('diversify')) {
    for (const query of queries.filter((item) => ['aggregation', 'single-session'].includes(item.category))) {
      cases.push({ variant: 'diversify', query, options: { diversify: true } });
    }
  }

  const results: Array<{
    variant: string;
    query_id: string;
    category: string;
    latency_ms: number;
    evaluation: ReturnType<typeof evaluate>;
    top: Candidate[];
    candidates: Candidate[];
  }> = [];

  for (const [index, item] of cases.entries()) {
    await paceAiRequest();
    const started = performance.now();
    const response = await jsonOrThrow<{ candidates: Candidate[] }>(await api('/api/v1/search', {
      method: 'POST',
      body: JSON.stringify({
        query: item.query.text,
        space_id: space.id,
        limit: TOP_K,
        rerank: item.options.rerank ?? true,
        graph: item.options.graph ?? true,
        diversify: item.options.diversify ?? false,
        include_source: false,
        recency_bias: item.options.recency_bias ?? null,
        recall_id: crypto.randomUUID(),
      }),
    }));
    const latencyMs = performance.now() - started;
    results.push({
      variant: item.variant,
      query_id: item.query.id,
      category: item.query.category,
      latency_ms: latencyMs,
      evaluation: evaluate(item.query, response.candidates),
      top: response.candidates.slice(0, 5),
      candidates: response.candidates,
    });
    console.error(`search ${index + 1}/${cases.length} ${item.variant}/${item.query.id} ${latencyMs.toFixed(0)}ms`);
  }

  const variants = [...new Set(results.map((result) => result.variant))];
  const summary = Object.fromEntries(variants.map((variant) => {
    const group = results.filter((result) => result.variant === variant);
    const answerable = group.filter((result) => result.evaluation.coverage !== null);
    const unanswerable = group.filter((result) => result.evaluation.coverage === null);
    const latencies = group.map((result) => result.latency_ms);
    return [variant, {
      query_count: group.length,
      mean_coverage: answerable.reduce((sum, result) => sum + result.evaluation.coverage!, 0) / Math.max(1, answerable.length),
      all_facts_rate: answerable.filter((result) => result.evaluation.all_facts).length / Math.max(1, answerable.length),
      top1_relevant_rate: answerable.filter((result) => result.evaluation.top1_relevant).length / Math.max(1, answerable.length),
      mean_reciprocal_rank: answerable.reduce((sum, result) => sum + result.evaluation.reciprocal_rank, 0) / Math.max(1, answerable.length),
      stale_before_fresh_count: answerable.filter((result) => result.evaluation.stale_before_fresh).length,
      unanswerable_mean_max_score: unanswerable.reduce((sum, result) => sum + (result.evaluation.max_score ?? 0), 0) / Math.max(1, unanswerable.length),
      latency_p50_ms: percentile(latencies, 0.5),
      latency_p95_ms: percentile(latencies, 0.95),
    }];
  }));

  const defaultResults = results.filter((result) => result.variant === 'default');
  const failures = defaultResults.filter((result) =>
    result.evaluation.coverage !== null
      ? !result.evaluation.all_facts || result.evaluation.stale_before_fresh
      : true,
  );
  const categorySummary = Object.fromEntries(
    [...new Set(defaultResults.map((result) => result.category))].map((category) => {
      const group = defaultResults.filter((result) => result.category === category && result.evaluation.coverage !== null);
      return [category, {
        count: group.length,
        mean_coverage: group.reduce((sum, result) => sum + result.evaluation.coverage!, 0) / Math.max(1, group.length),
        all_facts_rate: group.filter((result) => result.evaluation.all_facts).length / Math.max(1, group.length),
        top1_relevant_rate: group.filter((result) => result.evaluation.top1_relevant).length / Math.max(1, group.length),
      }];
    }),
  );

  console.log(JSON.stringify({
    run_id: runId,
    space_id: space.id,
    production_base_url: BASE_URL,
    corpus: { sessions: EXISTING_SPACE_ID ? 0 : sessions.length, queries: queries.length },
    ingestion_latency_ms: {
      p50: percentile(jobStats, 0.5),
      p95: percentile(jobStats, 0.95),
    },
    summary,
    default_by_category: categorySummary,
    failures,
    results,
  }, null, 2));
}

await main();
