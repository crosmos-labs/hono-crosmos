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
  sources,
  type Database,
  type Memory,
} from '@crosmos/db';
import { durationMs, type Logger } from '@crosmos/observability';
import type { TenantScope } from '@crosmos/types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { VectorStore } from '@crosmos/vector';
import {
  CHUNK_CONCURRENCY,
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
   * Total number of chunks this source was split into (whether or not they
   * yielded memories) — across ALL invocations, not just this one.
   */
  chunkCount: number;
  /**
   * Chunks actually processed THIS invocation (the current batch). The job-level
   * handler sums these to enforce the per-invocation chunk budget (issues #1/#2).
   * Zero when the source was already fully processed on a prior invocation.
   */
  processedChunkCount: number;
  /**
   * Chunks still to process AFTER this invocation (issue #9). `> 0` means the
   * source is NOT done — the durable `ingest_next_sequence` checkpoint in
   * `source.meta` has advanced and the job must be re-queued so a fresh
   * invocation continues from the checkpoint. `0` means the source is complete.
   */
  remainingChunkCount: number;
  /**
   * Estimated input tokens of this source's content (set at ingest time). The
   * job-level handler sums these over COMPLETED sources to meter the monthly
   * `tokens_ingested` quota on what the user submitted, not pipeline throughput.
   * Only reported on the FINAL batch (remainingChunkCount === 0) so a multi-batch
   * source is billed its input once, not per batch.
   */
  tokenCount: number;
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
   * Max NEW chunks this invocation may process for this source (issues #2/#9).
   * `ingestSource` resumes from the source's `ingest_next_sequence` checkpoint
   * and processes at most this many chunks, then returns `remainingChunkCount`.
   * Undefined = no budget limit (process all remaining chunks; used by direct
   * callers/tests). The job-level handler passes the invocation's remaining
   * budget so total chunks across all sources stay within one invocation's cap.
   */
  chunkBudgetRemaining?: number;
}

const EMPTY_RESULT = (
  sourceId: number,
  tokenCount = 0,
  chunkCount = 0,
  processedChunkCount = 0,
  remainingChunkCount = 0,
): IngestResult => ({
  sourceId,
  memories: [],
  edges: [],
  newEntityIds: [],
  resolvedEntityIds: [],
  chunkCount,
  processedChunkCount,
  remainingChunkCount,
  tokenCount,
});

export interface BatchPlan {
  /** First chunk index to process this invocation (inclusive). */
  start: number;
  /** One past the last chunk to process this invocation (exclusive). */
  end: number;
  /** Chunks remaining AFTER this invocation (0 ⇒ source complete). */
  remaining: number;
}

/**
 * Pure batch planner for the resumable pipeline (issue #9). Given the total
 * chunk count, the durable checkpoint (`nextSeq`), and this invocation's chunk
 * `budget`, returns the half-open [start, end) range to process and how many
 * chunks remain after. Both inputs are clamped defensively. Isolated + exported
 * so the off-by-one-critical arithmetic is unit-tested without a full pipeline
 * harness. `budget <= 0` ⇒ empty batch (start === end), remaining = whatever's
 * left, so the caller re-queues without doing work.
 */
export function planBatch(
  chunkCount: number,
  nextSeq: number,
  budget: number,
): BatchPlan {
  const start = Math.min(Math.max(0, Math.trunc(nextSeq)), chunkCount);
  const end = budget <= 0 ? start : Math.min(chunkCount, start + Math.trunc(budget));
  return { start, end, remaining: chunkCount - end };
}

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
export async function purgeSourceArtifacts(
  db: Database,
  vectorStore: VectorStore,
  sourceId: number,
  minSequence = 0,
): Promise<number> {
  // `minSequence` scopes the purge to chunks at or after a sequence — used by the
  // batched pipeline to clean ONLY a partially-written batch left by a canceled/
  // failed prior invocation (chunks >= the durable checkpoint), while preserving
  // the chunks committed before it. `minSequence = 0` purges the whole source
  // (a fresh start / full redrive), the original behaviour.
  const chunkRows = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(
      minSequence > 0
        ? and(eq(chunks.sourceId, sourceId), sql`${chunks.sequence} >= ${minSequence}`)
        : eq(chunks.sourceId, sourceId),
    );
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
  // Scoped to the EXACT ids the query above collected — NOT `sourceId` — so a
  // resumed batch (`minSequence > 0`) erases only the partially-written tail.
  // Deleting by `sourceId` here would drop the chunks committed BEFORE the
  // checkpoint while leaving their memories in place, cascading away the
  // `chunk_memories` citations that tie those memories to their evidence (and
  // leaving the memories unattributable — a later purge can no longer discover
  // them, so they'd be orphaned forever).
  await db.delete(chunks).where(inArray(chunks.id, chunkIds));
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
  // Reject NaN AND degenerate years (e.g. `0000-01-01`, a valid JS year-0 Date
  // that Postgres `timestamptz` refuses) so a malformed session date falls back
  // to wall-clock `recordedAt` instead of failing the source on the DB write.
  const parsedSessionDate = sessionDate ? new Date(sessionDate) : null;
  const validSessionDate = isSafePgDate(parsedSessionDate)
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
  // for pronoun resolution); text/markdown are split by a recursive character
  // splitter. Ports `app/engine/ingestion/pipeline.py:_chunk_source`.
  const sourceChunks = chunkSource(contentType, content, meta);
  if (sourceChunks.length === 0) return EMPTY_RESULT(sourceId, source.tokenCount);
  const chunkCount = sourceChunks.length;
  if (chunkCount > CONVERSATION_CHUNK_WARN_THRESHOLD) {
    logger?.warn('ingestion.chunk_count_high', {
      source_id: sourceId,
      chunk_count: chunkCount,
      threshold: CONVERSATION_CHUNK_WARN_THRESHOLD,
    });
  }

  // Abuse ceiling (issue #1). Sources now checkpoint + resume across invocations,
  // so a big source no longer has to fit in one invocation — but a pathologically
  // huge one is still failed terminally with a clear "split it" message rather
  // than churning through hundreds of batches. Well-formed input never trips it.
  if (chunkCount > MAX_CHUNKS_PER_SOURCE) {
    throw new SourceTooLargeError(sourceId, chunkCount, MAX_CHUNKS_PER_SOURCE);
  }

  // Stage 0.55 — resume from the durable checkpoint (issue #9). A source is
  // processed in BATCHES across invocations so a single invocation never blows
  // the 1000-subrequest cap or the wall-clock the runtime cancels past (the
  // source-520 stall). `ingest_next_sequence` in meta is the number of chunks
  // fully committed — including their Stage-8 entities/edges — by prior
  // invocations. Clamp defensively in case meta was hand-edited or the source
  // was re-chunked to a different length.
  const rawNextSeq = Number(
    (meta as Record<string, unknown>).ingest_next_sequence ?? 0,
  );
  const nextSeq = Number.isFinite(rawNextSeq) ? rawNextSeq : 0;

  // This invocation's batch: the next `budget` not-yet-processed chunks. An
  // undefined budget (direct callers / tests) processes all remaining chunks.
  const budget = input.chunkBudgetRemaining ?? chunkCount - nextSeq;
  const plan = planBatch(chunkCount, nextSeq, budget);
  const batch = sourceChunks.slice(plan.start, plan.end);
  if (batch.length === 0) {
    // Nothing to do this invocation. Two cases, both leave the checkpoint
    // untouched: (a) no budget left (earlier sources used it) → remaining > 0,
    // the handler re-queues; (b) already fully processed on a prior invocation
    // (checkpoint === chunkCount) → remaining 0, the handler finalizes.
    return EMPTY_RESULT(
      sourceId,
      source.tokenCount,
      chunkCount,
      0,
      plan.remaining,
    );
  }

  // Stage 0.6 — purge only a PARTIALLY-written batch left by a canceled/failed
  // prior invocation: chunks at or after the checkpoint. Chunks before it are
  // durably committed and MUST be preserved so the source makes forward progress
  // instead of re-running from the top every attempt (the source-520 failure
  // mode). On a fresh start (nextSeq === 0) this purges the whole source.
  // Idempotent: a clean slate is a single empty indexed SELECT.
  const purgeStart = performance.now();
  const purged = await purgeSourceArtifacts(db, vectorStore, sourceId, plan.start);
  if (purged > 0) {
    logger?.info('ingestion.stage_completed', {
      stage: 'purge_partial_batch',
      duration_ms: durationMs(purgeStart),
      memory_count: purged,
      from_sequence: plan.start,
    });
  }

  // Dedup keys shared across chunks of THIS batch so a fact recurring in
  // overlapping windows isn't persisted twice (#8). Cross-BATCH duplicates are
  // caught by the Stage-1 vector dedup hint against already-persisted memories.
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

    // Empty is a valid terminal extraction result. In particular, when the
    // existing-memory hint already covers the content, retrying without that
    // hint would bypass dedup and persist the same fact again.
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
      if (inferred) {
        const inferredDate = new Date(inferred);
        if (isSafePgDate(inferredDate)) f.eventTime = inferredDate;
      }
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
            // Extraction has always produced a speaker role, and the cross-chunk
            // dedup key has always included it, but persistence used to drop it
            // — so the signal was computed and discarded on every ingest.
            // `normalizeFacts` has already validated it to one of user /
            // assistant / system / tool, or null when unattributed.
            speakerRole: f.speakerRole,
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

  // Process THIS batch's chunks with bounded concurrency (issue #1) to cut
  // wall-clock — independent chunks needn't run strictly serially. The
  // per-invocation subrequest budget is a TOTAL, not a concurrency limit, so this
  // changes latency, not the cap math. Cross-chunk dedup (`seenFactKeys`) is
  // best-effort and tolerates the interleaving. A chunk that throws (retryable
  // infra error) aborts the batch; its partially-written chunks are purged from
  // the checkpoint on the next attempt, so a retry never duplicates.
  const allIngested: { memoryId: number; fact: NormalizedFact }[] = [];
  for (let i = 0; i < batch.length; i += CHUNK_CONCURRENCY) {
    // Mid-source lease heartbeat (issue #1), once per concurrency window:
    // re-stamp the job's `started_at` so a long-but-healthy source isn't
    // reclaimed and double-processed. Throttled + best-effort in the caller.
    await input.heartbeat?.();
    const window = batch.slice(i, i + CHUNK_CONCURRENCY);
    const windowResults = await Promise.all(window.map((chunk) => ingestChunk(chunk)));
    for (const r of windowResults) allIngested.push(...r);
  }

  // Stage 8 — entity resolution + memory_entities + edges for THIS batch's facts.
  // Running it per-batch (not once across the whole source) is safe: entity
  // resolution is idempotent by (space, lower(name)) so an entity seen in an
  // earlier batch resolves to the same row, and edges dedup within-run against
  // the monotonic graph. Skipped when the batch yielded no memories.
  let ingestedMemories: IngestedMemory[] = [];
  let ingestedEdges: IngestedEdge[] = [];
  let resolved: Awaited<ReturnType<typeof resolveEntities>> = [];
  if (allIngested.length > 0) {
    const allFacts = allIngested.map((im) => im.fact);
    const uniqueEntities = collectUniqueEntities(allFacts);
    const entityResolutionStart = performance.now();
    resolved = await resolveEntities(db, scope, uniqueEntities, embedder, vectorStore, logger);
    const nameToId = buildNameToIdMap(resolved);
    logger?.info('ingestion.stage_completed', {
      stage: 'entity_resolution',
      duration_ms: durationMs(entityResolutionStart),
      entity_count: resolved.length,
    });

    ingestedMemories = allIngested.map((im) => {
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
    ingestedEdges = await createEdgesFromFacts(
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
  }

  // Advance the durable checkpoint (issue #9). This batch's chunks and their
  // Stage-8 artifacts are committed, so record how far we've reached: a future
  // canceled/failed batch purges only from here on, never re-doing this work —
  // the source always makes forward progress. On the final batch we DROP the key
  // so a legitimate future re-ingest (source flipped back to `pending`) starts
  // clean. Merged into meta so sibling keys (redrive_attempts, url, …) survive.
  const remainingChunkCount = plan.remaining;
  const checkpointPatch =
    remainingChunkCount > 0
      ? sql`jsonb_set(coalesce(${sources.meta}, '{}'::jsonb), '{ingest_next_sequence}', to_jsonb(${plan.end}::int))`
      : sql`(coalesce(${sources.meta}, '{}'::jsonb) - 'ingest_next_sequence')`;
  await db
    .update(sources)
    .set({ meta: checkpointPatch, updatedAt: new Date() })
    .where(eq(sources.id, sourceId));
  logger?.info('ingestion.batch_checkpoint', {
    from_sequence: plan.start,
    to_sequence: plan.end,
    chunk_count: chunkCount,
    remaining_chunk_count: remainingChunkCount,
  });

  return {
    sourceId,
    memories: ingestedMemories,
    edges: ingestedEdges,
    newEntityIds: resolved.filter((r) => r.isNew).map((r) => r.entityId),
    resolvedEntityIds: resolved.filter((r) => !r.isNew).map((r) => r.entityId),
    chunkCount,
    processedChunkCount: batch.length,
    remainingChunkCount,
    // Bill the source's input tokens only on the FINAL batch so a multi-batch
    // source is metered once (on completion), not per batch.
    tokenCount: remainingChunkCount > 0 ? 0 : source.tokenCount,
  };
}

/**
 * A `Date` Postgres `timestamptz` will accept: parseable AND within a sane year
 * range. JS parses `0000-01-01` (and other degenerate values) into a valid
 * year-0 Date that is NOT NaN, but the DB write then fails with "date/time field
 * value out of range", taking the whole source down. Mirrors the same guard in
 * `extractors/normalize.ts:parseIsoDate`.
 */
function isSafePgDate(d: Date | null | undefined): d is Date {
  if (!d || Number.isNaN(d.getTime())) return false;
  const year = d.getUTCFullYear();
  return year >= 1 && year <= 9999;
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
