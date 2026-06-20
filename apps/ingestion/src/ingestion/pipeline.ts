/**
 * `ingestSource` — single-source pipeline. Ports
 * `app/engine/ingestion/pipeline.py:ingest_source` end-to-end.
 *
 * Stages (see docs/ingestion_migration/pipeline.md):
 *   0.  Load + preprocess source
 *   0.5 Chunk by content type (conversations → turn windows; else one chunk)
 *
 *   Per chunk (stages 1–7, in `ingestChunk`):
 *     1. Existing-memory dedup hint (search-mode embedding of the chunk, top-10)
 *     2. Pass 1: memory extraction (LLM)
 *     3. Pass 2: graph extraction (LLM, non-fatal)
 *     4. Normalize + dedupe facts
 *     5. Temporal regex fallback for null event_time
 *     6. Batch embed
 *     7. Persist chunk + memories + chunk_memories
 *
 *   Once across all chunks:
 *     8. Resolve entities + memory_entities + edges
 */
import {
  chunks,
  edges,
  memories as memoriesTable,
  memoryEntities,
  chunkMemories,
  type Database,
  type Memory,
} from '@crosmos/db';
import { durationMs, type Logger } from '@crosmos/observability';
import type { TenantScope } from '@crosmos/types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { VectorStore } from '@crosmos/vector';
import {
  CONVERSATION_CHUNK_WARN_THRESHOLD,
  EXISTING_MEMORY_LOOKUP_LIMIT,
  MAX_CHUNKS_PER_SOURCE,
} from '../constants';
import { extractGraph, extractMemories } from '../extractors/extract';
import { DropCounter, normalizeFacts } from '../extractors/normalize';
import {
  buildNameToIdMap,
  casefold,
  resolveEntities,
} from '../extractors/resolve-entity';
import { inferTemporalDate } from '../extractors/temporal';
import type { NormalizedFact } from '../extractors/types';
import { EmbeddingRequestError, type Embedder } from '../integrations/embeddings';
import { LLMRequestError, type LLM } from '../integrations/llm';
import { chunkSource, type SourceChunk } from './chunking';
import { createEdgesFromFacts, type IngestedEdge } from './edges';
import { loadSource } from './source-loader';

export interface IngestedMemory {
  memoryId: number;
  fact: NormalizedFact;
  entityIds: number[];
}

export interface IngestResult {
  sourceId: number;
  memories: IngestedMemory[];
  edges: IngestedEdge[];
  newEntityIds: number[];
  resolvedEntityIds: number[];
  /**
   * Number of chunks this source was split into (whether or not they yielded
   * memories). The job-level handler sums these to enforce the per-invocation
   * chunk budget (issues #1 / #2).
   */
  chunkCount: number;
}

/**
 * A single source produced more chunks than one Cloudflare invocation can safely
 * process under the subrequest cap. Terminal for that source — it must be split
 * across multiple sources at the producer. Non-retryable.
 */
export class SourceTooLargeError extends Error {
  constructor(
    public readonly sourceId: number,
    public readonly chunkCount: number,
    public readonly maxChunks: number,
  ) {
    super(
      `Source ${sourceId} has ${chunkCount} chunks, exceeding the per-source limit of ${maxChunks}; split it across multiple sources`,
    );
    this.name = 'SourceTooLargeError';
  }
}

/**
 * Processing this source would exceed the REMAINING per-invocation chunk budget.
 * NOT a failure: the source is left untouched, the job is re-queued, and the
 * remaining sources run in a fresh invocation with a full budget (issue #2).
 */
export class JobBudgetExceededError extends Error {
  constructor(
    public readonly sourceId: number,
    public readonly chunkCount: number,
    public readonly remaining: number,
  ) {
    super(
      `Source ${sourceId} (${chunkCount} chunks) exceeds the remaining invocation budget (${remaining}); deferring to a re-queue`,
    );
    this.name = 'JobBudgetExceededError';
  }
}

export interface IngestSourceInput {
  db: Database;
  scope: TenantScope;
  sourceId: number;
  llm: LLM;
  embedder: Embedder;
  vectorStore: VectorStore;
  modelOverride?: string;
  /** Caller-supplied pronoun-resolution context (overrides meta.lookback_context). */
  context?: string;
  /** Caller-supplied dedup hint (overrides the Stage-1 DB lookup). */
  existingMemories?: string[];
  logger?: Logger;
  /**
   * Mid-source lease heartbeat (issue #1). Called once per chunk; the job-level
   * handler throttles it to re-stamp `started_at` so a long-but-healthy source
   * isn't reclaimed and double-processed. Best-effort — must never throw.
   */
  heartbeat?: () => Promise<void>;
  /**
   * Chunks still available in the current invocation's budget (issue #2). When
   * this source isn't the first processed this invocation and its chunk count
   * exceeds this, `ingestSource` throws `JobBudgetExceededError` before doing any
   * work, so the job-level handler can defer it to a re-queue.
   */
  chunkBudgetRemaining?: number;
  /**
   * True when no source has been processed yet this invocation. The first source
   * always proceeds (up to `MAX_CHUNKS_PER_SOURCE`) so the job can't livelock.
   */
  isFirstSourceThisInvocation?: boolean;
}

const EMPTY_RESULT = (sourceId: number, chunkCount = 0): IngestResult => ({
  sourceId,
  memories: [],
  edges: [],
  newEntityIds: [],
  resolvedEntityIds: [],
  chunkCount,
});

function failureFields(err: unknown): {
  error_category: 'external_service' | 'internal';
  dependency: 'embedding' | 'llm' | 'database' | 'pipeline';
} {
  if (err instanceof EmbeddingRequestError) {
    return { error_category: 'external_service', dependency: 'embedding' };
  }
  if (err instanceof LLMRequestError) {
    return { error_category: 'external_service', dependency: 'llm' };
  }
  return { error_category: 'internal', dependency: 'pipeline' };
}

/**
 * Idempotency purge — delete any derived artifacts left by a PRIOR ingestion
 * attempt for this source before re-creating them. `ingestSource` is not
 * atomic across its stages, and the per-source retry loop (and the queue
 * backstop reclaiming a job whose run died mid-source) both re-run it from the
 * top. Without this, a failure after Stage 7 (persist) duplicates memories and
 * vectors on the next attempt, because each run inserts rows with fresh serial
 * IDs that the vector store can't dedupe.
 *
 * A source fully owns its chunks → memories (+ their vectors) → memory_entities
 * / edges. Entities are shared and resolved idempotently by name, so they (and
 * their vectors) are intentionally left intact. On a clean first attempt the
 * source has no chunks yet, so this is a single empty indexed SELECT.
 */
async function purgeSourceArtifacts(
  db: Database,
  vectorStore: VectorStore,
  sourceId: number,
): Promise<number> {
  const chunkRows = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(eq(chunks.sourceId, sourceId));
  if (chunkRows.length === 0) return 0; // clean slate — happy path, nothing to undo
  const chunkIds = chunkRows.map((c) => c.id);

  const memRows = await db
    .select({ memoryId: chunkMemories.memoryId })
    .from(chunkMemories)
    .where(inArray(chunkMemories.chunkId, chunkIds));
  const memoryIds = [...new Set(memRows.map((m) => m.memoryId))];

  if (memoryIds.length > 0) {
    // edges.memory_id is ON DELETE SET NULL, so deleting memories would orphan
    // the edges rather than remove them — delete them explicitly first.
    await db.delete(edges).where(inArray(edges.memoryId, memoryIds));
    // Delete index vectors BEFORE the PG rows (issue #5). `deleteByIds` is
    // idempotent, and `chunk_memories` — which we walk above to re-derive these
    // ids — is only cascaded away when the memory rows are deleted. So if this
    // vector delete throws, the next attempt still finds the chunks, re-derives
    // the same ids, and retries the delete. Deleting the PG rows first would make
    // the ids unrecoverable, orphaning those vectors in the index permanently.
    if (!vectorStore.persistsInColumn) {
      await vectorStore.deleteByIds('memories', memoryIds);
    }
    // Deleting memories cascades chunk_memories + memory_entities.
    await db.delete(memoriesTable).where(inArray(memoriesTable.id, memoryIds));
  }
  // Remove the chunk(s) themselves (cascades any remaining chunk_memories).
  await db.delete(chunks).where(eq(chunks.sourceId, sourceId));
  return memoryIds.length;
}

export async function ingestSource(input: IngestSourceInput): Promise<IngestResult> {
  const { db, scope, sourceId, llm, embedder, vectorStore, logger } = input;

  // Stage 0 — load + preprocess. Load and chunk FIRST (both read-only /
  // in-memory) so the per-invocation bounds (issues #1 / #2) are enforced BEFORE
  // the destructive purge or any expensive AI work — an over-budget source must
  // be left completely untouched so a re-queue can process it cleanly later.
  const loadStart = performance.now();
  const source = await loadSource(db, sourceId);
  const contentType = (source.contentType ?? 'text').toLowerCase();
  if (contentType !== 'text' && contentType !== 'markdown' && contentType !== 'conversation') {
    throw new Error(`Unsupported content_type: ${source.contentType}`);
  }
  const content = source.content.replaceAll('', '');
  const meta = (source.meta as Record<string, unknown> | null) ?? {};
  const sessionDate = typeof meta.date === 'string' ? meta.date : null;
  const lookbackContext =
    typeof meta.lookback_context === 'string' ? meta.lookback_context : null;
  // A valid, parsed session date — or null. Relative-date resolution (both the
  // LLM `reference_time` and the Stage-5 temporal-regex fallback) MUST anchor to
  // this and NOT to ingestion wall-clock: anchoring "yesterday" to now is wrong
  // for any backfilled / replayed source (issue #8). `recordedAt` is when we
  // learned the fact and is always a concrete timestamp (now if no date given).
  const parsedSessionDate = sessionDate ? new Date(sessionDate) : null;
  const validSessionDate =
    parsedSessionDate && !Number.isNaN(parsedSessionDate.getTime())
      ? parsedSessionDate
      : null;
  const referenceTime = validSessionDate ? validSessionDate.toISOString() : null;
  const temporalBase = validSessionDate;
  const recordedAt = validSessionDate ?? new Date();
  const ownerUserId = source.ownerUserId;
  const visibility = source.visibility as 'private' | 'org';
  logger?.info('ingestion.stage_completed', {
    stage: 'load_source',
    duration_ms: durationMs(loadStart),
  });

  // Stage 0.5 — chunk the source by content type. Conversations become
  // fixed-size turn windows (each carrying the prior window as lookback context
  // for pronoun resolution); text/markdown pass through as a single chunk.
  // Ports `app/engine/ingestion/pipeline.py:_chunk_source`.
  const sourceChunks = chunkSource(contentType, content, meta);
  if (sourceChunks.length === 0) return EMPTY_RESULT(sourceId);
  const chunkCount = sourceChunks.length;
  if (chunkCount > CONVERSATION_CHUNK_WARN_THRESHOLD) {
    logger?.warn('ingestion.chunk_count_high', {
      source_id: sourceId,
      chunk_count: chunkCount,
      threshold: CONVERSATION_CHUNK_WARN_THRESHOLD,
    });
  }

  // Per-source hard cap (issue #1). A single source runs entirely in one
  // Cloudflare invocation (1000-subrequest cap) and can't be split across
  // invocations — purge re-runs it from the top — so a source over the cap can
  // never complete. Fail it terminally with a clear "split it" message instead
  // of silently blowing the cap and getting reclaimed/retried forever.
  if (chunkCount > MAX_CHUNKS_PER_SOURCE) {
    throw new SourceTooLargeError(sourceId, chunkCount, MAX_CHUNKS_PER_SOURCE);
  }
  // Per-invocation budget (issue #2). If this source won't fit the budget the
  // job has left AND it isn't the first source this invocation, defer it: throw
  // before any work so the job-level handler re-queues and a fresh invocation
  // (full budget) picks it up. The first source always proceeds (guarded by the
  // per-source cap above) so the job can't livelock.
  if (
    input.isFirstSourceThisInvocation === false &&
    input.chunkBudgetRemaining !== undefined &&
    chunkCount > input.chunkBudgetRemaining
  ) {
    throw new JobBudgetExceededError(sourceId, chunkCount, input.chunkBudgetRemaining);
  }

  // Stage 0.6 — now that bounds pass, purge any partial artifacts from a prior
  // failed/interrupted attempt so re-running this source can't duplicate
  // memories or vectors (the pipeline isn't atomic across stages).
  const purgeStart = performance.now();
  const purged = await purgeSourceArtifacts(db, vectorStore, sourceId);
  if (purged > 0) {
    logger?.info('ingestion.stage_completed', {
      stage: 'purge_prior_artifacts',
      duration_ms: durationMs(purgeStart),
      memory_count: purged,
    });
  }

  // Dedup keys shared across ALL chunks of this source so a fact that recurs in
  // overlapping chunks (e.g. via lookback context) isn't persisted twice (#8).
  const seenFactKeys = new Set<string>();

  // Stages 1–7 for a single chunk: dedup hint → extract → graph → normalize →
  // temporal → embed → persist. Returns the persisted memories paired with the
  // facts they came from; entity ids are resolved later, once across all chunks.
  // Mirrors Python's `_ingest_chunk`.
  const ingestChunk = async (
    chunk: SourceChunk,
  ): Promise<{ memoryId: number; fact: NormalizedFact }[]> => {
    const { sequence, content: chunkContent, chunker } = chunk;
    const chunkContext = chunk.context ?? input.context ?? lookbackContext ?? null;

    // Stage 1 — existing-memory dedup hint (search-mode embedding of THIS
    // chunk, not the whole source: a bounded, focused dedup query).
    let existingMemories = input.existingMemories;
    if (!existingMemories) {
      const lookupStart = performance.now();
      try {
        const embedStart = performance.now();
        const { vector } = await embedder.embed(chunkContent, { mode: 'search' });
        logger?.info('embedding.request_completed', {
          stage: 'existing_memory_lookup',
          sequence,
          embedding_mode: 'search',
          embedding_count: 1,
          duration_ms: durationMs(embedStart),
        });
        const matches = await vectorStore.queryNearest(
          'memories',
          vector,
          { orgId: scope.orgId, spaceId: scope.spaceId },
          { topK: EXISTING_MEMORY_LOOKUP_LIMIT },
        );
        const ids = matches.map((m) => m.id);
        if (ids.length === 0) {
          existingMemories = [];
        } else {
          // Load content for the ANN hits, dropping any that were forgotten
          // since indexing (the vector store may still return them). Preserve
          // similarity order from the ANN result.
          const rows = await db
            .select({ id: memoriesTable.id, content: memoriesTable.content })
            .from(memoriesTable)
            .where(
              and(
                inArray(memoriesTable.id, ids),
                sql`${memoriesTable.forgottenAt} IS NULL`,
              ),
            );
          const contentById = new Map(rows.map((r) => [r.id, r.content]));
          existingMemories = ids
            .map((id) => contentById.get(id))
            .filter((c): c is string => c !== undefined);
        }
        logger?.info('ingestion.stage_completed', {
          stage: 'existing_memory_lookup',
          sequence,
          duration_ms: durationMs(lookupStart),
          memory_count: existingMemories.length,
        });
      } catch (err) {
        logger?.warn('ingestion.existing_memory_lookup_failed', {
          stage: 'existing_memory_lookup',
          sequence,
          duration_ms: durationMs(lookupStart),
          ...failureFields(err),
        }, err);
        existingMemories = [];
      }
    }

    // Stage 2 — memory extraction
    const memoryExtractionStart = performance.now();
    const llmTokensBeforeMemory = llm.totalTokens;
    let rawMemories: Awaited<ReturnType<typeof extractMemories>>;
    try {
      rawMemories = await extractMemories(llm, {
        content: chunkContent,
        referenceTime,
        context: chunkContext,
        existingMemories,
      }, input.modelOverride);
    } catch (err) {
      logger?.error('llm.request_failed', {
        stage: 'memory_extraction',
        sequence,
        model: input.modelOverride ?? llm.defaultModel,
        duration_ms: durationMs(memoryExtractionStart),
        token_count: llm.totalTokens - llmTokensBeforeMemory,
        ...failureFields(err),
      }, err);
      throw err;
    }
    logger?.info('llm.request_completed', {
      stage: 'memory_extraction',
      sequence,
      model: input.modelOverride ?? llm.defaultModel,
      duration_ms: durationMs(memoryExtractionStart),
      memory_count: rawMemories.length,
      token_count: llm.totalTokens - llmTokensBeforeMemory,
    });
    if (rawMemories.length === 0) return [];

    // Stage 3 — graph extraction (non-fatal). Matches Python's
    // `extract_memories` which runs Pass 2 inside the same call.
    let rawGraph: Awaited<ReturnType<typeof extractGraph>> = [];
    const graphExtractionStart = performance.now();
    const llmTokensBeforeGraph = llm.totalTokens;
    try {
      rawGraph = await extractGraph(
        llm,
        rawMemories.map((m) => ({ content: m.content })),
        input.modelOverride,
      );
      logger?.info('llm.request_completed', {
        stage: 'graph_extraction',
        sequence,
        model: input.modelOverride ?? llm.defaultModel,
        duration_ms: durationMs(graphExtractionStart),
        memory_count: rawMemories.length,
        token_count: llm.totalTokens - llmTokensBeforeGraph,
      });
    } catch (err) {
      logger?.warn('ingestion.graph_extraction_failed', {
        stage: 'graph_extraction',
        sequence,
        model: input.modelOverride ?? llm.defaultModel,
        duration_ms: durationMs(graphExtractionStart),
        token_count: llm.totalTokens - llmTokensBeforeGraph,
        ...failureFields(err),
      }, err);
      rawGraph = [];
    }

    // Stage 4 — normalize + dedup. Runs BEFORE temporal fallback so the
    // fallback only sees facts that survived normalization (matches Python's
    // ordering in `app/engine/ingestion/pipeline.py`).
    const drops = new DropCounter();
    const normalizeStart = performance.now();
    const facts = normalizeFacts(rawMemories, rawGraph, drops, seenFactKeys);
    logger?.info('ingestion.stage_completed', {
      stage: 'normalize_facts',
      sequence,
      duration_ms: durationMs(normalizeStart),
      memory_count: facts.length,
    });
    if (facts.length === 0) return [];

    // Stage 5 — temporal regex fallback for facts the LLM left without an
    // event_time. Mutates `facts` in place, matching Python.
    for (const f of facts) {
      if (f.eventTime) continue;
      const inferred = inferTemporalDate(f.content, temporalBase);
      if (inferred) f.eventTime = new Date(inferred);
    }

    // Stage 6 — batch embed memory contents (month suffix when event_time set)
    const embedTexts = facts.map((f) => buildEnrichedEmbeddingText(f));
    const memoryEmbedStart = performance.now();
    let vectors: number[][];
    try {
      ({ vectors } = await embedder.embedBatch(embedTexts, { mode: 'document' }));
    } catch (err) {
      logger?.error('embedding.request_failed', {
        stage: 'memory_embedding',
        sequence,
        embedding_mode: 'document',
        embedding_count: embedTexts.length,
        duration_ms: durationMs(memoryEmbedStart),
        ...failureFields(err),
      }, err);
      throw err;
    }
    logger?.info('embedding.request_completed', {
      stage: 'memory_embedding',
      sequence,
      embedding_mode: 'document',
      embedding_count: embedTexts.length,
      duration_ms: durationMs(memoryEmbedStart),
    });
    if (vectors.length !== facts.length) {
      throw new Error(
        `Embedder returned ${vectors.length} vectors for ${facts.length} facts`,
      );
    }
    // Validate against the CONFIGURED embedder's dimension — the single source
    // of truth (derived from EMBEDDING_DIMENSIONS env via getEmbedder /
    // assertEmbeddingSpace), not a hardcoded constant that can drift from the
    // deployed model / vector store dimension. See issue #3.
    for (const v of vectors) {
      if (v.length !== embedder.dimensions) {
        throw new Error(
          `Expected ${embedder.dimensions}-dim embedding, got ${v.length}`,
        );
      }
    }

    // Stage 7 — persist chunk + memories + chunk_memories atomically, THEN
    // upsert vectors. The three inserts run in one transaction so a memory row
    // can never exist without its chunk_memories link — that link is what
    // `purgeSourceArtifacts` walks to find and clean a prior attempt's
    // memories. Vectors are upserted after commit (Vectorize isn't part of the
    // PG transaction); if that upsert fails, the next attempt's purge finds the
    // committed memories via the link and removes them + these vectors before
    // re-inserting, so a retry never duplicates.
    const persistStart = performance.now();
    const memoryRows: Memory[] = await db.transaction(async (tx) => {
      const [chunkRow] = await tx
        .insert(chunks)
        .values({
          orgId: scope.orgId,
          spaceId: scope.spaceId,
          sourceId,
          sequence,
          content: chunkContent,
          tokenCount: 0,
          chunker,
        })
        .returning();
      if (!chunkRow) throw new Error('Failed to insert chunk');

      const rows: Memory[] = await tx
        .insert(memoriesTable)
        .values(
          facts.map((f, i) => ({
            orgId: scope.orgId,
            spaceId: scope.spaceId,
            ownerUserId,
            visibility,
            content: f.content,
            memoryType: f.memoryType,
            // Vectors are stored in the configured vector store. For the pg
            // backend that IS this column; for vectorize the column stays null
            // and the vector is upserted to the index after commit.
            embedding: vectorStore.persistsInColumn ? vectors[i]! : null,
            importanceScore: f.importanceScore,
            eventTime: f.eventTime,
            recordedAt,
          })),
        )
        .returning();
      if (rows.length !== facts.length) {
        throw new Error(
          `Memory insert returned ${rows.length} rows for ${facts.length} facts`,
        );
      }

      await tx.insert(chunkMemories).values(
        rows.map((m) => ({
          chunkId: chunkRow.id,
          memoryId: m.id,
          extractionTimestamp: recordedAt,
        })),
      );
      return rows;
    });

    // Upsert vectors to the vector store (no-op for the pg backend, which
    // already wrote them to the column above). memoryRows[i] ↔ vectors[i] by
    // insert order.
    if (!vectorStore.persistsInColumn) {
      await vectorStore.upsert(
        'memories',
        memoryRows.map((m, i) => ({
          id: m.id,
          vector: vectors[i]!,
          orgId: scope.orgId,
          spaceId: scope.spaceId,
        })),
      );
    }
    logger?.info('ingestion.stage_completed', {
      stage: 'persist_memories',
      sequence,
      duration_ms: durationMs(persistStart),
      memory_count: memoryRows.length,
    });

    return facts.map((f, i) => ({ memoryId: memoryRows[i]!.id, fact: f }));
  };

  // Run chunks sequentially. Concurrency comes from running multiple sources /
  // jobs at once, which keeps total in-flight LLM calls bounded by active jobs
  // rather than active jobs × chunks (and one source's subrequests within the
  // per-invocation cap). Mirrors Python's sequential chunk loop.
  const allIngested: { memoryId: number; fact: NormalizedFact }[] = [];
  for (const chunk of sourceChunks) {
    // Mid-source lease heartbeat (issue #1): re-stamp the job's `started_at` so a
    // long-but-healthy source isn't reclaimed and double-processed concurrently.
    // Throttled + best-effort in the caller; never throws.
    await input.heartbeat?.();
    allIngested.push(...(await ingestChunk(chunk)));
  }
  if (allIngested.length === 0) return EMPTY_RESULT(sourceId, chunkCount);

  // Stage 8 — entity resolution + memory_entities + edges, ONCE across all
  // chunks. Entities are shared, so a single resolution pass dedupes them
  // globally and edges can link memories extracted from different chunks.
  const allFacts = allIngested.map((im) => im.fact);
  const uniqueEntities = collectUniqueEntities(allFacts);
  const entityResolutionStart = performance.now();
  const resolved = await resolveEntities(db, scope, uniqueEntities, embedder, vectorStore, logger);
  const nameToId = buildNameToIdMap(resolved);
  logger?.info('ingestion.stage_completed', {
    stage: 'entity_resolution',
    duration_ms: durationMs(entityResolutionStart),
    entity_count: resolved.length,
  });

  const ingestedMemories: IngestedMemory[] = allIngested.map((im) => {
    const ids = new Set<number>();
    for (const e of im.fact.entities) {
      const id = nameToId.get(casefold(e.name));
      if (id !== undefined) ids.add(id);
    }
    return { memoryId: im.memoryId, fact: im.fact, entityIds: Array.from(ids) };
  });

  const junctionRows = ingestedMemories.flatMap((im) =>
    im.entityIds.map((entityId) => ({ memoryId: im.memoryId, entityId })),
  );
  if (junctionRows.length > 0) {
    const junctionStart = performance.now();
    await db.insert(memoryEntities).values(junctionRows).onConflictDoNothing();
    logger?.info('ingestion.stage_completed', {
      stage: 'memory_entity_links',
      duration_ms: durationMs(junctionStart),
      entity_count: junctionRows.length,
    });
  }

  const edgeStart = performance.now();
  const ingestedEdges = await createEdgesFromFacts(
    db,
    scope,
    ingestedMemories.map((im) => ({ memoryId: im.memoryId, fact: im.fact })),
    nameToId,
    recordedAt,
    ownerUserId,
    visibility,
  );
  logger?.info('ingestion.stage_completed', {
    stage: 'edge_creation',
    duration_ms: durationMs(edgeStart),
    edge_count: ingestedEdges.length,
  });

  return {
    sourceId,
    memories: ingestedMemories,
    edges: ingestedEdges,
    newEntityIds: resolved.filter((r) => r.isNew).map((r) => r.entityId),
    resolvedEntityIds: resolved.filter((r) => !r.isNew).map((r) => r.entityId),
    chunkCount,
  };
}

/** Append `(happened in {Month YYYY})` when event_time is set — improves recall. */
function buildEnrichedEmbeddingText(f: NormalizedFact): string {
  if (!f.eventTime) return f.content;
  const month = f.eventTime.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${f.content} (happened in ${month})`;
}

/** Dedup by `name.trim().casefold()` across all facts in this run. */
function collectUniqueEntities(facts: NormalizedFact[]) {
  const seen = new Map<string, { name: string; entityType: string }>();
  for (const f of facts) {
    for (const e of f.entities) {
      const key = casefold(e.name);
      if (!seen.has(key)) seen.set(key, { name: e.name, entityType: e.entityType });
    }
  }
  return Array.from(seen.values());
}
