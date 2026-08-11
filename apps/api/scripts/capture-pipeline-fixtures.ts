#!/usr/bin/env bun
/**
 * Capture Tier-1 fixtures for the deterministic pipeline baseline (P0-A).
 *
 * Runs the REAL ingestion pipeline and the REAL retrieval orchestrator once,
 * against the REAL providers (OpenAI embeddings + extraction, ZeroEntropy
 * rerank) and the local test database, recording every provider request and
 * response. The tests then replay those recordings, so they exercise the same
 * production code paths deterministically, offline, and for free.
 *
 * This is the only step that costs money or needs API keys. It is deliberately
 * a script and not a test: capturing is an occasional, reviewed act.
 *
 *   docker compose up -d postgres
 *   bash scripts/test-db-setup.sh
 *   bun --cwd apps/api scripts/capture-pipeline-fixtures.ts
 *
 * Keys are read from apps/ingestion/.dev.vars (OPENAI_API_KEY) and
 * apps/api/.dev.vars (ZEROENTROPY_API_KEY), or the environment.
 *
 * Re-capture when the extraction prompt, the embedding model, the reranker, or
 * the corpus changes. The resulting diff is the review surface: a changed
 * extraction fixture means the prompt now produces different facts, which is
 * exactly the kind of change that should be looked at rather than absorbed.
 */
import { createDb } from '@crosmos/db';
import { getLLM } from '../../ingestion/src/integrations/llm';
import { OpenAIEmbedder } from '@crosmos/ai';
import { ZeroEntropyReranker } from '@crosmos/ai';
import {
  FixtureStore,
  MemoryVectorStore,
  hybridEmbedder,
  hybridLLM,
  hybridReranker,
  replayEmbedder,
  replayLLM,
  replayReranker,
  resetTestData,
  seedTenant,
} from '@crosmos/test-support';
// The ingest/retrieve routine is SHARED with the baseline test, so capture and
// replay cannot drift apart. See tests/fixtures/harness.ts.
import {
  ingestCorpus,
  QUERIES,
  runCorpusQuery,
  toBaselineCandidates,
} from '../tests/fixtures/harness';

const FIXTURE_PATH = new URL('../tests/fixtures/pipeline-fixtures.json', import.meta.url).pathname;
const BASELINE_PATH = new URL('../tests/fixtures/retrieval-baseline.json', import.meta.url).pathname;
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://crosmos:crosmos@localhost:5433/crosmos_test';

/** Read a key from .dev.vars without printing it. */
async function devVar(file: string, name: string): Promise<string | undefined> {
  if (process.env[name]) return process.env[name];
  try {
    const text = await Bun.file(file).text();
    const m = new RegExp(`^${name}="?([^"\\n]+)`, 'm').exec(text);
    return m?.[1];
  } catch {
    return undefined;
  }
}

const root = new URL('../../../', import.meta.url).pathname;
const OPENAI_API_KEY = await devVar(`${root}apps/ingestion/.dev.vars`, 'OPENAI_API_KEY');
const ZEROENTROPY_API_KEY = await devVar(`${root}apps/api/.dev.vars`, 'ZEROENTROPY_API_KEY');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not found (env or apps/ingestion/.dev.vars)');
if (!ZEROENTROPY_API_KEY) throw new Error('ZEROENTROPY_API_KEY not found (env or apps/api/.dev.vars)');

// Production's dimension. Must match what the tests replay with.
const DIMENSIONS = 1536;

const store = new FixtureStore();
const db = createDb(TEST_DATABASE_URL, { max: 4 });

console.log('resetting the test database…');
await resetTestData(db);
const tenant = await seedTenant(db);

// In-memory external index — models Qdrant's shape (`persistsInColumn: false`),
// which is the branch production actually takes. See MemoryVectorStore.
const vectorStore = new MemoryVectorStore();

const EMBED_MODEL = `openai-${DIMENSIONS}`;
const RERANK_MODEL = 'zerank-2';
const MAX_PASSES = 6;

const realEmbedder = new OpenAIEmbedder({ apiKey: OPENAI_API_KEY, dimensions: DIMENSIONS });
const realLLM = getLLM({ LLM_PROVIDER: 'openai', OPENAI_API_KEY } as never);
const realReranker = new ZeroEntropyReranker({ apiKey: ZEROENTROPY_API_KEY });

// ── Capture to a fixpoint ───────────────────────────────────────────────────
//
// One recording pass is not closed under replay: provider output feeds back
// into later decisions (the dedup hint reads vectors written earlier, entity
// resolution fuzzy-matches an embedding candidate pool, `event_time` shapes the
// text that gets embedded). So a replay can legitimately request something the
// recording never asked for. Repeat with replay-or-record providers until a
// pass requests nothing new; the fixture set is then closed under its own
// replay, which is the property the tests need.
let baseline: Record<string, unknown> = {};
let pass = 0;
for (; pass < MAX_PASSES; pass++) {
  let misses = 0;
  const onMiss = () => {
    misses += 1;
  };

  await resetTestData(db);
  const tenant = await seedTenant(db);
  const vectorStore = new MemoryVectorStore();
  const scope = { orgId: tenant.orgId, spaceId: tenant.spaceId, userId: tenant.userId };

  const embedder = hybridEmbedder(realEmbedder, store, EMBED_MODEL, onMiss);
  const llm = hybridLLM(realLLM, store, onMiss);
  const reranker = hybridReranker(realReranker, store, onMiss);

  console.log(`\npass ${pass + 1}: ingesting the corpus…`);
  await ingestCorpus({
    db,
    scope,
    llm,
    embedder,
    vectorStore,
    onSession: (sess) =>
      console.log(
        `  ${sess.sessionId}: ${sess.memoryContents.length} memories, ` +
          `${sess.edgeCount} edges, ${sess.chunkCount} chunks`,
      ),
  });

  baseline = {};
  for (const q of QUERIES) {
    const result = await runCorpusQuery({
      db, scope, query: q, embedder, reranker, vectorStore,
    });
    baseline[q.id] = { query: q.text, candidates: toBaselineCandidates(result) };
  }

  console.log(`  pass ${pass + 1}: ${misses} provider call(s) not already recorded`);
  if (misses === 0) break;
}

if (pass === MAX_PASSES) {
  console.error(
    `\nCAPTURE REJECTED — still requesting new provider calls after ${MAX_PASSES} passes.\n` +
      'The pipeline is not converging to a reproducible run, which is a real ' +
      'finding worth investigating rather than working around.',
  );
  process.exit(1);
}

// ── Verify the capture is actually replayable ───────────────────────────────
//
// A fixture set that cannot reproduce its own recording is worthless: the test
// would either fail on a missing key or, worse, pass against a different run.
// The pipeline reads provider output back into later prompts (the Stage-1 dedup
// hint) and into enrichment (`event_time` shapes the embedded text), so a single
// recording pass is NOT self-evidently replayable. Prove it here, in the script
// that owns the problem, instead of discovering it in a test days later.
console.log('\nverifying the capture replays faithfully…');
await resetTestData(db);
const verifyTenant = await seedTenant(db);
const verifyStore = new MemoryVectorStore();
const verifyScope = {
  orgId: verifyTenant.orgId,
  spaceId: verifyTenant.spaceId,
  userId: verifyTenant.userId,
};

try {
  await ingestCorpus({
    db,
    scope: verifyScope,
    llm: replayLLM(store),
    embedder: replayEmbedder(store, DIMENSIONS, `openai-${DIMENSIONS}`),
    vectorStore: verifyStore,
  });
  for (const q of QUERIES) {
    const replayed = await runCorpusQuery({
      db,
      scope: verifyScope,
      query: q,
      embedder: replayEmbedder(store, DIMENSIONS, `openai-${DIMENSIONS}`),
      reranker: replayReranker(store, 'zerank-2'),
      vectorStore: verifyStore,
    });
    const before = JSON.stringify(baseline[q.id]);
    const after = JSON.stringify({ query: q.text, candidates: toBaselineCandidates(replayed) });
    if (before !== after) {
      throw new Error(
        `replay produced different retrieval output for ${q.id}.\n` +
          `  recorded: ${before.slice(0, 300)}\n` +
          `  replayed: ${after.slice(0, 300)}`,
      );
    }
  }
  console.log('  replay reproduced the recording exactly.');
} catch (err) {
  console.error('\nCAPTURE REJECTED — it does not replay faithfully:\n');
  console.error(err instanceof Error ? err.message : String(err));
  console.error(
    '\nNothing was written. The usual cause is provider nondeterminism feeding ' +
      'back into a later prompt, so the recorded run cannot be reconstructed. ' +
      'Re-run to try again; if it keeps failing on the same fact, the pipeline ' +
      'has a genuine reproducibility problem worth fixing rather than papering over.',
  );
  process.exit(1);
}

if (store.collisions.length > 0) {
  console.error(
    `\nWARNING: ${store.collisions.length} fixture key collision(s) — the same ` +
      'request produced different responses in this capture, so replay cannot ' +
      'reproduce it faithfully:',
  );
  for (const k of store.collisions) console.error(`  ${k}`);
}

await store.save(
  FIXTURE_PATH,
  'Real OpenAI embeddings + extraction and ZeroEntropy reranks, captured by ' +
    'scripts/capture-pipeline-fixtures.ts. Replayed by the P0-A baseline tests.',
);
await Bun.write(
  BASELINE_PATH,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      note:
        'Expected retrieval output for the fixture corpus. A diff here means ' +
        'ranking changed — review it, do not regenerate reflexively.',
      queries: baseline,
    },
    null,
    2,
  )}\n`,
);

console.log(`\nwrote ${store.size} provider fixtures → ${FIXTURE_PATH}`);
console.log(`wrote retrieval baseline            → ${BASELINE_PATH}`);
process.exit(0);
