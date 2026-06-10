/**
 * `ingestSource` — single-source pipeline. Ports
 * `app/engine/ingestion/pipeline.py:ingest_source` end-to-end.
 *
 * Stages (see docs/ingestion_migration/pipeline.md):
 *   0. Load + preprocess source
 *   1. Existing-memory dedup hint (search-mode embedding, top-10)
 *   2. Pass 1: memory extraction (LLM)
 *   3. Pass 2: graph extraction (LLM, non-fatal)
 *   4. Temporal regex fallback for null event_time
 *   5. Normalize + dedupe facts
 *   6. Batch embed
 *   7. Persist memories + source_memories
 *   8. Resolve entities + memory_entities + edges
 */
import {
  chunks,
  memories as memoriesTable,
  memoryEntities,
  chunkMemories,
  type Database,
  type Memory,
} from '@crosmos/db';
import { durationMs, type Logger } from '@crosmos/observability';
import type { TenantScope } from '@crosmos/types';
import { and, inArray, sql } from 'drizzle-orm';
import type { VectorStore } from '@crosmos/vector';
import {
  EMBEDDING_DIMENSIONS,
  EXISTING_MEMORY_LOOKUP_LIMIT,
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
}

const EMPTY_RESULT = (sourceId: number): IngestResult => ({
  sourceId,
  memories: [],
  edges: [],
  newEntityIds: [],
  resolvedEntityIds: [],
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

export async function ingestSource(input: IngestSourceInput): Promise<IngestResult> {
  const { db, scope, sourceId, llm, embedder, vectorStore, logger } = input;

  // Stage 0 — load + preprocess
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
  const referenceTime = sessionDate ?? new Date().toISOString();
  const learnedTime = (() => {
    const d = new Date(referenceTime);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  })();
  const context = input.context ?? lookbackContext ?? null;
  const ownerUserId = source.ownerUserId;
  const visibility = source.visibility as 'private' | 'org';
  logger?.info('ingestion.stage_completed', {
    stage: 'load_source',
    duration_ms: durationMs(loadStart),
  });

  // Stage 1 — existing-memory dedup hint (search-mode embedding, top-N)
  let existingMemories = input.existingMemories;
  if (!existingMemories) {
    const lookupStart = performance.now();
    try {
      const embedStart = performance.now();
      const { vector } = await embedder.embed(content, { mode: 'search' });
      logger?.info('embedding.request_completed', {
        stage: 'existing_memory_lookup',
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
        duration_ms: durationMs(lookupStart),
        memory_count: existingMemories.length,
      });
    } catch (err) {
      logger?.warn('ingestion.existing_memory_lookup_failed', {
        stage: 'existing_memory_lookup',
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
      content,
      referenceTime,
      context,
      existingMemories,
    }, input.modelOverride);
  } catch (err) {
    logger?.error('llm.request_failed', {
      stage: 'memory_extraction',
      model: input.modelOverride ?? llm.defaultModel,
      duration_ms: durationMs(memoryExtractionStart),
      token_count: llm.totalTokens - llmTokensBeforeMemory,
      ...failureFields(err),
    }, err);
    throw err;
  }
  logger?.info('llm.request_completed', {
    stage: 'memory_extraction',
    model: input.modelOverride ?? llm.defaultModel,
    duration_ms: durationMs(memoryExtractionStart),
    memory_count: rawMemories.length,
    token_count: llm.totalTokens - llmTokensBeforeMemory,
  });
  if (rawMemories.length === 0) return EMPTY_RESULT(sourceId);

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
      model: input.modelOverride ?? llm.defaultModel,
      duration_ms: durationMs(graphExtractionStart),
      memory_count: rawMemories.length,
      token_count: llm.totalTokens - llmTokensBeforeGraph,
    });
  } catch (err) {
    logger?.warn('ingestion.graph_extraction_failed', {
      stage: 'graph_extraction',
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
  const facts = normalizeFacts(rawMemories, rawGraph, drops);
  logger?.info('ingestion.stage_completed', {
    stage: 'normalize_facts',
    duration_ms: durationMs(normalizeStart),
    memory_count: facts.length,
  });
  if (facts.length === 0) return EMPTY_RESULT(sourceId);

  // Stage 5 — temporal regex fallback for facts the LLM left without an
  // event_time. Mutates `facts` in place, matching Python.
  for (const f of facts) {
    if (f.eventTime) continue;
    const inferred = inferTemporalDate(f.content, learnedTime);
    if (inferred) f.eventTime = new Date(inferred);
  }

  // Stage 6 — batch embed memory contents (with month suffix when event_time present)
  const embedTexts = facts.map((f) => buildEnrichedEmbeddingText(f));
  const memoryEmbedStart = performance.now();
  let vectors: number[][];
  try {
    ({ vectors } = await embedder.embedBatch(embedTexts, { mode: 'document' }));
  } catch (err) {
    logger?.error('embedding.request_failed', {
      stage: 'memory_embedding',
      embedding_mode: 'document',
      embedding_count: embedTexts.length,
      duration_ms: durationMs(memoryEmbedStart),
      ...failureFields(err),
    }, err);
    throw err;
  }
  logger?.info('embedding.request_completed', {
    stage: 'memory_embedding',
    embedding_mode: 'document',
    embedding_count: embedTexts.length,
    duration_ms: durationMs(memoryEmbedStart),
  });
  if (vectors.length !== facts.length) {
    throw new Error(
      `Embedder returned ${vectors.length} vectors for ${facts.length} facts`,
    );
  }
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${v.length}`,
      );
    }
  }

  // Stage 7 — persist memories + source_memories
  const persistStart = performance.now();
  const [chunk] = await db
    .insert(chunks)
    .values({
      orgId: scope.orgId,
      spaceId: scope.spaceId,
      sourceId,
      sequence: 0,
      content,
      tokenCount: source.tokenCount,
      chunker: contentType === 'conversation' ? 'conversation' : 'legacy',
    })
    .returning();
  if (!chunk) throw new Error('Failed to insert chunk');

  const memoryRows: Memory[] = await db
    .insert(memoriesTable)
    .values(
      facts.map((f, i) => ({
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        ownerUserId,
        visibility,
        content: f.content,
        memoryType: f.memoryType,
        // Vectors are stored in the configured vector store. For the pg backend
        // that IS this column; for vectorize the column stays null and the
        // vector is upserted to the index below.
        embedding: vectorStore.persistsInColumn ? vectors[i]! : null,
        importanceScore: f.importanceScore,
        eventTime: f.eventTime,
        recordedAt: learnedTime,
      })),
    )
    .returning();
  if (memoryRows.length !== facts.length) {
    throw new Error(
      `Memory insert returned ${memoryRows.length} rows for ${facts.length} facts`,
    );
  }

  // Upsert vectors to the vector store (no-op for the pg backend, which already
  // wrote them to the column above). memoryRows[i] ↔ vectors[i] by insert order.
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

  await db.insert(chunkMemories).values(
    memoryRows.map((m) => ({
      chunkId: chunk.id,
      memoryId: m.id,
      extractionTimestamp: learnedTime,
    })),
  );
  logger?.info('ingestion.stage_completed', {
    stage: 'persist_memories',
    duration_ms: durationMs(persistStart),
    memory_count: memoryRows.length,
  });

  // Stage 8 — entity resolution + memory_entities + edges
  const uniqueEntities = collectUniqueEntities(facts);
  const entityResolutionStart = performance.now();
  const resolved = await resolveEntities(db, scope, uniqueEntities, embedder, vectorStore, logger);
  const nameToId = buildNameToIdMap(resolved);
  logger?.info('ingestion.stage_completed', {
    stage: 'entity_resolution',
    duration_ms: durationMs(entityResolutionStart),
    entity_count: resolved.length,
  });

  const ingestedMemories: IngestedMemory[] = facts.map((f, i) => {
    const ids = new Set<number>();
    for (const e of f.entities) {
      const id = nameToId.get(casefold(e.name));
      if (id !== undefined) ids.add(id);
    }
    return { memoryId: memoryRows[i]!.id, fact: f, entityIds: Array.from(ids) };
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
    learnedTime,
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
