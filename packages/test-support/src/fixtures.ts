/**
 * Record/replay for the AI providers, so the pipeline can be exercised
 * deterministically and offline (checklist P0-A, "Tier 1").
 *
 * **Why record rather than fake.** The interesting regressions are in ranking —
 * RRF, recency, persistence, the relevance floor, session diversity, MMR — and
 * those are pure functions of the signal inputs. A hand-written fake would let
 * us assert whatever the fake produced; a recording of a REAL OpenAI embedding
 * and a REAL ZeroEntropy rerank makes the inputs realistic *and* fixed, so the
 * assertions are about our code and nothing else.
 *
 * **Why not call the providers in CI.** The score would move run to run from
 * model nondeterminism, a gate that red-lights on noise gets switched off, and
 * every PR would cost money and burn rate limit. Model drift is a real question
 * but a different one, answered on a different cadence by the benchmark repo.
 *
 * **Misses are loud.** Replay throws on an unknown key rather than inventing a
 * response. A silently-fabricated embedding would produce a green test that
 * proves nothing, which is worse than a red one.
 */
import { createHash } from 'node:crypto';

/**
 * One recorded provider exchange. The REQUEST is stored next to the response on
 * purpose: a content-addressed key alone makes a replay miss undebuggable ("no
 * fixture for hash abc123" tells you nothing), and it makes the committed diff
 * unreviewable. With the request present, a changed extraction prompt shows up
 * as readable before/after text.
 */
export interface FixtureEntry {
  request: unknown;
  response: unknown;
}

export interface FixtureFile {
  /** Free-text note about how/when this was captured. */
  capturedAt: string;
  note: string;
  entries: Record<string, FixtureEntry>;
}

/** Content-addressed key. Same request → same key, across machines and runs. */
export function fixtureKey(kind: string, parts: unknown[]): string {
  const payload = JSON.stringify([kind, ...parts]);
  return `${kind}:${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`;
}

export class FixtureStore {
  private readonly entries: Record<string, FixtureEntry>;
  /** Keys actually read during a run — used to prune dead fixtures. */
  readonly used = new Set<string>();

  constructor(file?: FixtureFile) {
    this.entries = file?.entries ?? {};
  }

  static async load(path: string): Promise<FixtureStore> {
    const file = JSON.parse(await Bun.file(path).text()) as FixtureFile;
    return new FixtureStore(file);
  }

  has(key: string): boolean {
    return key in this.entries;
  }

  get<T>(key: string, describe: string, request?: unknown): T {
    const entry = this.entries[key];
    if (entry === undefined) {
      // Show the nearest recorded request. A miss is almost always a near-miss
      // — one changed character in a prompt or an enrichment suffix — and the
      // diff between "asked" and "closest recorded" points straight at it.
      const kind = key.split(':')[0]!;
      const asked = JSON.stringify(request ?? describe);
      const nearest = this.nearestRequest(kind, asked);
      throw new Error(
        `Missing fixture for ${describe} (key ${key}).\n` +
          `  asked:            ${asked}\n` +
          (nearest ? `  closest recorded: ${nearest}\n` : '') +
          'Replay refuses to invent a provider response — a fabricated embedding ' +
          'would make this test pass while proving nothing.\n' +
          'Re-capture with: bun --cwd apps/api scripts/capture-pipeline-fixtures.ts',
      );
    }
    this.used.add(key);
    return entry.response as T;
  }

  /** Recorded request of the same kind sharing the longest prefix with `asked`. */
  private nearestRequest(kind: string, asked: string): string | null {
    let best: string | null = null;
    let bestShared = 0;
    for (const [k, v] of Object.entries(this.entries)) {
      if (!k.startsWith(`${kind}:`)) continue;
      const candidate = JSON.stringify(v.request);
      let shared = 0;
      while (
        shared < candidate.length &&
        shared < asked.length &&
        candidate[shared] === asked[shared]
      ) shared++;
      if (shared > bestShared) {
        bestShared = shared;
        best = candidate;
      }
    }
    return bestShared > 20 ? best : null;
  }

  /** Keys recorded more than once with a DIFFERENT response. */
  readonly collisions: string[] = [];

  set(key: string, request: unknown, response: unknown): void {
    const existing = this.entries[key];
    if (
      existing !== undefined &&
      JSON.stringify(existing.response) !== JSON.stringify(response)
    ) {
      // The same request produced two different responses in one capture. The
      // last write wins, so replay would serve one response for both calls and
      // silently diverge from the recorded run. Surfaced rather than absorbed:
      // it means the key is not capturing everything that varies.
      this.collisions.push(key);
    }
    this.entries[key] = { request, response };
  }

  /** Recorded requests, for diagnosing a replay miss. */
  requests(kind: string): unknown[] {
    return Object.entries(this.entries)
      .filter(([k]) => k.startsWith(`${kind}:`))
      .map(([, v]) => v.request);
  }

  async save(path: string, note: string): Promise<void> {
    const file: FixtureFile = {
      capturedAt: new Date().toISOString(),
      note,
      // Sorted so a re-capture produces a reviewable diff rather than a reshuffle.
      entries: Object.fromEntries(
        Object.entries(this.entries).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    await Bun.write(path, `${JSON.stringify(file, null, 2)}\n`);
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }
}

// ── Provider shapes ─────────────────────────────────────────────────────────
// Declared structurally rather than imported, so this package stays free of
// dependencies on either Worker.

interface EmbedOptionsLike {
  mode?: string;
  signal?: AbortSignal;
}
interface EmbedderLike {
  readonly dimensions: number;
  readonly totalTokens: number;
  embed(
    text: string,
    opts?: EmbedOptionsLike,
  ): Promise<{ vector: number[]; usage: { promptTokens: number; totalTokens: number } }>;
  embedBatch(
    texts: string[],
    opts?: EmbedOptionsLike,
  ): Promise<{ vectors: number[][]; usage: { promptTokens: number; totalTokens: number } }>;
}

interface RerankerLike {
  readonly defaultModel: string;
  rerank(
    query: string,
    documents: string[],
    opts?: { topK?: number; model?: string; signal?: AbortSignal },
  ): Promise<Array<{ index: number; score: number }>>;
}

interface LLMLike {
  readonly totalTokens: number;
  completeJson<T>(input: {
    system: string;
    user: string;
    schema?: unknown;
    model?: string;
    maxTokens?: number;
  }): Promise<{ data: T; usage?: unknown }>;
}

const embedKey = (model: string, mode: string, text: string) =>
  fixtureKey('embed', [model, mode, text]);
const rerankKey = (model: string, query: string, documents: string[]) =>
  fixtureKey('rerank', [model, query, documents]);
const llmKey = (system: string, user: string) => fixtureKey('llm', [system, user]);

/** Wrap a real embedder so every call is recorded. */
export function recordingEmbedder(
  inner: EmbedderLike,
  store: FixtureStore,
  model = 'default',
): EmbedderLike {
  return {
    get dimensions() {
      return inner.dimensions;
    },
    get totalTokens() {
      return inner.totalTokens;
    },
    async embed(text, opts) {
      const result = await inner.embed(text, opts);
      store.set(
        embedKey(model, opts?.mode ?? 'document', text),
        { model, mode: opts?.mode ?? 'document', text },
        result.vector,
      );
      return result;
    },
    async embedBatch(texts, opts) {
      const result = await inner.embedBatch(texts, opts);
      texts.forEach((t, i) => {
        store.set(
          embedKey(model, opts?.mode ?? 'document', t),
          { model, mode: opts?.mode ?? 'document', text: t },
          result.vectors[i]!,
        );
      });
      return result;
    },
  };
}

/** Serve embeddings from fixtures. Deterministic, offline, zero cost. */
export function replayEmbedder(
  store: FixtureStore,
  dimensions: number,
  model = 'default',
): EmbedderLike {
  let totalTokens = 0;
  const one = (text: string, mode: string): number[] => {
    const vector = store.get<number[]>(
      embedKey(model, mode, text),
      `embedding (mode=${mode})`,
      { model, mode, text },
    );
    // Token usage is not modelled: nothing under test reads it, and inventing a
    // number would quietly make billing assertions meaningless.
    totalTokens += 0;
    return vector;
  };
  return {
    dimensions,
    get totalTokens() {
      return totalTokens;
    },
    async embed(text, opts) {
      return {
        vector: one(text, opts?.mode ?? 'document'),
        usage: { promptTokens: 0, totalTokens: 0 },
      };
    },
    async embedBatch(texts, opts) {
      return {
        vectors: texts.map((t) => one(t, opts?.mode ?? 'document')),
        usage: { promptTokens: 0, totalTokens: 0 },
      };
    },
  };
}

export function recordingReranker(inner: RerankerLike, store: FixtureStore): RerankerLike {
  return {
    get defaultModel() {
      return inner.defaultModel;
    },
    async rerank(query, documents, opts) {
      const results = await inner.rerank(query, documents, opts);
      store.set(
        rerankKey(inner.defaultModel, query, documents),
        { model: inner.defaultModel, query, documents },
        results,
      );
      return results;
    },
  };
}

export function replayReranker(store: FixtureStore, model: string): RerankerLike {
  return {
    defaultModel: model,
    async rerank(query, documents) {
      if (documents.length === 0) return [];
      return store.get(
        rerankKey(model, query, documents),
        `rerank of ${documents.length} documents`,
        { model, query, documents },
      );
    },
  };
}

export function recordingLLM(inner: LLMLike, store: FixtureStore): LLMLike {
  return {
    get totalTokens() {
      return inner.totalTokens;
    },
    async completeJson<T>(input: {
      system: string;
      user: string;
      schema?: unknown;
      model?: string;
      maxTokens?: number;
    }): Promise<{ data: T; usage?: unknown }> {
      const result = await inner.completeJson<T>(input);
      store.set(llmKey(input.system, input.user), { user: input.user }, result.data);
      return result;
    },
  };
}

/**
 * Serve extraction results from fixtures. This is what makes ingestion
 * reproducible: the extraction LLM is nondeterministic, so recording pins one
 * realization and every later run compares against exactly that.
 */
export function replayLLM(store: FixtureStore): LLMLike {
  return {
    totalTokens: 0,
    async completeJson<T>(input: {
      system: string;
      user: string;
    }): Promise<{ data: T; usage?: unknown }> {
      const data = store.get<T>(
        llmKey(input.system, input.user),
        'LLM completion',
        { user: input.user },
      );
      return { data };
    },
  };
}

// ── Hybrid (replay-or-record) providers ─────────────────────────────────────
//
// Why these exist: a single recording pass is NOT closed under replay. Provider
// output feeds back into later decisions — the Stage-1 dedup hint queries
// vectors written earlier, entity resolution fuzzy-matches against an embedding
// candidate pool, and `event_time` shapes the text that gets embedded. So
// replaying a recording can legitimately ask for a request the recording never
// made, and OpenAI returning marginally different vectors for identical input is
// enough to flip a fuzzy entity match.
//
// A hybrid provider serves a fixture when present and calls the real provider
// (recording it) on a miss. Running the capture repeatedly with these until a
// pass requests nothing new reaches a fixpoint: a fixture set closed under its
// own replay. That is the property the tests actually need.

export function hybridEmbedder(
  inner: EmbedderLike,
  store: FixtureStore,
  model: string,
  onMiss: () => void,
): EmbedderLike {
  const recorder = recordingEmbedder(inner, store, model);
  return {
    get dimensions() {
      return inner.dimensions;
    },
    get totalTokens() {
      return inner.totalTokens;
    },
    async embed(text, opts) {
      const key = embedKey(model, opts?.mode ?? 'document', text);
      if (store.has(key)) {
        return { vector: store.get<number[]>(key, 'embedding'), usage: { promptTokens: 0, totalTokens: 0 } };
      }
      onMiss();
      return recorder.embed(text, opts);
    },
    async embedBatch(texts, opts) {
      const mode = opts?.mode ?? 'document';
      // Only the misses go to the provider; hits come from the store. Keeps a
      // re-capture cheap even when one new text appears in a large batch.
      const missing = texts.filter((t) => !store.has(embedKey(model, mode, t)));
      if (missing.length > 0) {
        onMiss();
        await recorder.embedBatch(missing, opts);
      }
      return {
        vectors: texts.map((t) => store.get<number[]>(embedKey(model, mode, t), 'embedding')),
        usage: { promptTokens: 0, totalTokens: 0 },
      };
    },
  };
}

export function hybridReranker(
  inner: RerankerLike,
  store: FixtureStore,
  onMiss: () => void,
): RerankerLike {
  const recorder = recordingReranker(inner, store);
  return {
    get defaultModel() {
      return inner.defaultModel;
    },
    async rerank(query, documents, opts) {
      if (documents.length === 0) return [];
      const key = rerankKey(inner.defaultModel, query, documents);
      if (store.has(key)) return store.get(key, 'rerank');
      onMiss();
      return recorder.rerank(query, documents, opts);
    },
  };
}

export function hybridLLM(
  inner: LLMLike,
  store: FixtureStore,
  onMiss: () => void,
): LLMLike {
  const recorder = recordingLLM(inner, store);
  return {
    get totalTokens() {
      return inner.totalTokens;
    },
    async completeJson<T>(input: {
      system: string;
      user: string;
      schema?: unknown;
      model?: string;
      maxTokens?: number;
    }): Promise<{ data: T; usage?: unknown }> {
      const key = llmKey(input.system, input.user);
      if (store.has(key)) return { data: store.get<T>(key, 'LLM completion') };
      onMiss();
      return recorder.completeJson<T>(input);
    },
  };
}
