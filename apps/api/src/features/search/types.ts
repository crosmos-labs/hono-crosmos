/**
 * Internal engine types — port of `app/engine/retrieval/types.py`. These never
 * hit the wire directly; the route maps `CandidateMemory` → the API response.
 */
import type { Memory, Entity } from '@crosmos/db';

/**
 * Projected memory row loaded for retrieval. The full `Memory` row also carries
 * an `embedding` vector plus `meta`/`uuid`/clustering columns that the ranking
 * pipeline never reads; loading the whole space's worth of those on every
 * /search is the O(N) working-set cost. We select only the columns the signals
 * and scoring actually touch. (Vectors needed by MMR are fetched separately,
 * by id, via `vectorStore.fetchVectors`.)
 */
export type RetrievalMemoryRow = Pick<
  Memory,
  | 'id'
  | 'uuid'
  | 'content'
  | 'memoryType'
  | 'ownerUserId'
  | 'orgId'
  | 'spaceId'
  | 'importanceScore'
  | 'createdAt'
  | 'recordedAt'
  | 'accessFrequency'
  | 'lastAccessedAt'
  | 'eventTime'
  | 'forgottenAt'
>;

/** Projected entity row — the graph signal only needs id + name (entity
 * embeddings are matched via ANN, not off these rows). */
export type RetrievalEntityRow = Pick<Entity, 'id' | 'name'>;

export enum SourceSignal {
  SEMANTIC = 'semantic',
  KEYWORD = 'keyword',
  GRAPH = 'graph',
  TEMPORAL = 'temporal',
}

export interface RetrievalQuery {
  text: string;
  topK: number; // default 10
  candidatePool: number; // default 50 — per-signal limit
  recencyBias: number | null; // default null
  rerank: boolean; // default true
  graph: boolean; // default true
  diversify: boolean; // default false
}

/**
 * Per-signal output. Every signal returns `RankedCandidate[]` with a 1-based
 * `rank` (by that signal's ordering) and a signal-specific `score`.
 */
export interface RankedCandidate {
  memoryId: number;
  content: string;
  memoryType: string;
  ownerUserId: number | null;
  orgId: number;
  spaceId: number;
  importanceScore: number | null;
  createdAt: Date;
  recordedAt: Date;
  accessFrequency: number;
  lastAccessedAt: Date;
  eventTime: Date | null;
  rank: number; // 1-based within the signal
  score: number; // signal-specific
  source: SourceSignal;
  sourceChunk: string | null; // filled later in the orchestrator
  sourceId: number | null; // filled later in the orchestrator
  sourceUuid: string | null; // source UUID, filled by attachSourceText
  sessionId: string | null; // source meta.session_id, filled by attachSourceText
}

/** The fused/scored output the orchestrator builds. */
export interface CandidateMemory {
  memoryId: number;
  content: string;
  memoryType: string;
  ownerUserId: number | null;
  orgId: number;
  spaceId: number;
  importanceScore: number | null;
  createdAt: Date;
  recordedAt: Date;
  accessFrequency: number;
  lastAccessedAt: Date;
  eventTime: Date | null;
  sourceSignals: SourceSignal[]; // which signals surfaced this memory
  sourceChunk: string | null;
  sourceId: number | null;
  sourceUuid: string | null;
  sessionId: string | null;
  fusedScore: number; // RRF score from the pool
  persistenceScore: number; // compute_persistence(...) — carried, NOT a multiplier
  finalScore: number; // base × (1 + clamp(boost))
  rerankScore: number; // the `base` score: calibrated CE relevance, or rank-remap fallback
  ceRelevance: boolean; // true when rerankScore is the cross-encoder's calibrated [0,1] score
}

export interface RetrievalResult {
  query: RetrievalQuery;
  candidates: CandidateMemory[]; // length ≤ topK
}

/** Intent classifier types (`intent.py`). Not wired into ranking — see intent.ts. */
export enum QueryIntent {
  PERSONAL = 'personal',
  PREFERENCE = 'preference',
  ENTITY_LOOKUP = 'entity_lookup',
  FACTUAL = 'factual',
}

export interface IntentAnalysis {
  intent: QueryIntent;
  confidence: number;
  matchedText: string | null;
}
