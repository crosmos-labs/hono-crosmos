import type {
  QueryOptions,
  UpsertItem,
  VectorCollection,
  VectorMatch,
  VectorScope,
  VectorStore,
} from './port';

/**
 * Qdrant-backed VectorStore. One collection per logical collection
 * (`memories`, `entities`), reached over Qdrant's REST API (no SDK — plain
 * `fetch`, so it runs unchanged on Cloudflare Workers). Tenant isolation uses a
 * payload filter on `spaceId` (mirrors the Vectorize per-space namespace);
 * `orgId`/`spaceId` are stored in the point payload.
 *
 * Collections must be created with the **Cosine** distance metric (see
 * `ensureQdrantCollections`), so Qdrant's returned `score` is already cosine
 * similarity (higher = more similar) and matches the port contract directly —
 * no normalization needed.
 *
 * Like Vectorize, Qdrant filters are implicit-AND and can't express the memory
 * visibility OR, so `queryNearest` filters by `spaceId` only; the caller
 * intersects results with the already-loaded visible working set (see the
 * semantic + graph signals).
 *
 * `persistsInColumn` is false: vectors live in Qdrant, not the PG column.
 */

const REQUEST_TIMEOUT_MS = 30_000;
// Point retrieval is batched to keep request bodies bounded.
const RETRIEVE_BATCH = 256;

// Bounded in-adapter retry for WRITES (upsert/delete) only. A write that fails
// with a retryable status (429 / 5xx / timeout) is almost always a transient
// blip — a brief Qdrant flush stall, a connection reset — that clears in well
// under a second. Retrying here absorbs it WITHOUT re-running the whole
// (expensive, LLM-bearing) source pipeline. Reads aren't retried here: the
// dedup-hint read is non-fatal (degrades to empty) and the per-source pipeline
// retry already covers read-path failures. Kept small so a genuinely red store
// fails fast and bubbles up to the job-level re-queue (issue #4) rather than
// burning the per-invocation subrequest budget on retries.
const WRITE_RETRY_ATTEMPTS = 3;
const WRITE_RETRY_BASE_MS = 200;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface QdrantStoreConfig {
  /** Cluster endpoint, e.g. `https://xxxx.aws.cloud.qdrant.io` (no trailing slash needed). */
  url: string;
  apiKey: string;
  /** Collection name for the `memories` logical collection. */
  memoriesCollection: string;
  /** Collection name for the `entities` logical collection. */
  entitiesCollection: string;
}

export class QdrantStore implements VectorStore {
  readonly persistsInColumn = false;
  private readonly base: string;

  constructor(private readonly config: QdrantStoreConfig) {
    this.base = config.url.replace(/\/+$/, '');
  }

  private collectionName(collection: VectorCollection): string {
    return collection === 'memories'
      ? this.config.memoriesCollection
      : this.config.entitiesCollection;
  }

  async upsert(collection: VectorCollection, items: UpsertItem[]): Promise<void> {
    if (items.length === 0) return;
    // wait=true so a subsequent read (dedup hint / entity-resolution prefilter)
    // sees the write — ingestion writes then immediately queries.
    await this.writeWithRetry('PUT', `/collections/${this.collectionName(collection)}/points?wait=true`, {
      points: items.map((it) => ({
        id: it.id,
        vector: it.vector,
        payload: { orgId: it.orgId, spaceId: it.spaceId },
      })),
    });
  }

  async queryNearest(
    collection: VectorCollection,
    vector: number[],
    scope: VectorScope,
    opts: QueryOptions,
  ): Promise<VectorMatch[]> {
    if (vector.length === 0 || opts.topK <= 0) return [];

    const body: Record<string, unknown> = {
      vector,
      limit: opts.topK,
      filter: { must: [{ key: 'spaceId', match: { value: scope.spaceId } }] },
      with_payload: false,
      with_vector: false,
    };
    if (opts.minScore !== undefined) body.score_threshold = opts.minScore;

    const json = await this.request<{ result: Array<{ id: number; score: number }> }>(
      'POST',
      `/collections/${this.collectionName(collection)}/points/search`,
      body,
    );

    const minScore = opts.minScore;
    const out: VectorMatch[] = [];
    for (const m of json.result) {
      const score = m.score;
      // Qdrant honours score_threshold, but guard client-side too so the
      // semantics exactly match the other adapters.
      if (minScore !== undefined && score < minScore) continue;
      out.push({ id: Number(m.id), score });
    }
    // Qdrant returns matches sorted by score desc already; keep that order.
    return out;
  }

  async queryNearestBatch(
    collection: VectorCollection,
    vectors: number[][],
    scope: VectorScope,
    opts: QueryOptions,
  ): Promise<VectorMatch[][]> {
    if (vectors.length === 0) return [];
    if (opts.topK <= 0) return vectors.map(() => []);

    const filter = { must: [{ key: 'spaceId', match: { value: scope.spaceId } }] };
    const searches = vectors.map((vector) => {
      const s: Record<string, unknown> = {
        vector,
        limit: opts.topK,
        filter,
        with_payload: false,
        with_vector: false,
      };
      if (opts.minScore !== undefined) s.score_threshold = opts.minScore;
      return s;
    });

    // One subrequest for all query vectors (vs one per vector) — keeps ingestion
    // under Cloudflare's per-invocation subrequest cap.
    const json = await this.request<{
      result: Array<Array<{ id: number; score: number }>>;
    }>('POST', `/collections/${this.collectionName(collection)}/points/search/batch`, {
      searches,
    });

    const minScore = opts.minScore;
    return json.result.map((matches) => {
      const out: VectorMatch[] = [];
      for (const m of matches) {
        if (minScore !== undefined && m.score < minScore) continue;
        out.push({ id: Number(m.id), score: m.score });
      }
      return out;
    });
  }

  async fetchVectors(
    collection: VectorCollection,
    ids: number[],
  ): Promise<Map<number, number[]>> {
    const result = new Map<number, number[]>();
    if (ids.length === 0) return result;
    const name = this.collectionName(collection);

    for (let i = 0; i < ids.length; i += RETRIEVE_BATCH) {
      const batch = ids.slice(i, i + RETRIEVE_BATCH);
      const json = await this.request<{
        result: Array<{ id: number; vector: number[] }>;
      }>('POST', `/collections/${name}/points`, {
        ids: batch,
        with_vector: true,
        with_payload: false,
      });
      for (const rec of json.result) {
        if (Array.isArray(rec.vector)) result.set(Number(rec.id), rec.vector);
      }
    }
    return result;
  }

  async deleteByIds(collection: VectorCollection, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.writeWithRetry(
      'POST',
      `/collections/${this.collectionName(collection)}/points/delete?wait=true`,
      { points: ids },
    );
  }

  /**
   * `request` wrapped in a bounded retry on retryable failures, for WRITES only.
   * Exponential backoff with jitter (200ms, ~400ms) so concurrent jobs don't
   * retry in lockstep against a recovering cluster. A non-retryable error (4xx
   * other than 429) throws immediately. After the budget is exhausted the last
   * `QdrantRequestError` propagates, where the job-level handler decides to
   * re-queue rather than terminally fail (issue #4).
   */
  private async writeWithRetry<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= WRITE_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.request<T>(method, path, body);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof QdrantRequestError && err.retryable;
        if (!retryable || attempt === WRITE_RETRY_ATTEMPTS) throw err;
        const backoff = WRITE_RETRY_BASE_MS * 2 ** (attempt - 1);
        await sleep(backoff + Math.floor(Math.random() * WRITE_RETRY_BASE_MS));
      }
    }
    throw lastErr;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'api-key': this.config.apiKey,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      throw new QdrantRequestError(
        `Qdrant ${method} ${path} ${
          isTimeout
            ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
            : `failed: ${err instanceof Error ? err.message : String(err)}`
        }`,
        504,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new QdrantRequestError(
        `Qdrant ${method} ${path} ${res.status}: ${text || res.statusText}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }
}

export class QdrantRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'QdrantRequestError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * Idempotently create the two Qdrant collections (Cosine distance, the given
 * dimension) and a keyword payload index on `spaceId` for fast tenant
 * filtering. Safe to call repeatedly — existing collections are left as-is.
 * Run once during setup/migration, not on the hot path.
 */
export async function ensureQdrantCollections(
  config: QdrantStoreConfig,
  dimensions: number,
): Promise<void> {
  const base = config.url.replace(/\/+$/, '');
  const headers = { 'api-key': config.apiKey, 'Content-Type': 'application/json' };

  for (const name of [config.memoriesCollection, config.entitiesCollection]) {
    // PUT /collections/{name} is idempotent-ish: 200 on create. If it already
    // exists Qdrant returns an error we tolerate.
    const createRes = await fetch(`${base}/collections/${name}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ vectors: { size: dimensions, distance: 'Cosine' } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      // 409/400 "already exists" is fine; anything else is a real failure.
      if (!/exist/i.test(text)) {
        throw new QdrantRequestError(
          `Qdrant create collection ${name} ${createRes.status}: ${text}`,
          createRes.status,
        );
      }
    }
    // Keyword index on spaceId so the tenant filter is indexed, not a scan.
    await fetch(`${base}/collections/${name}/index?wait=true`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ field_name: 'spaceId', field_schema: 'integer' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {
      /* index may already exist — ignore */
    });
  }
}
