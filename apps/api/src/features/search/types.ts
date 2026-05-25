/**
 * Internal engine types — port of `app/engine/retrieval/types.py`. These never
 * hit the wire directly; the route maps `CandidateMemory` → the API response.
 */

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
}

/** The fused/scored output the orchestrator builds. */
export interface CandidateMemory {
  memoryId: number;
  content: string;
  memoryType: string;
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
  fusedScore: number; // RRF score from the pool
  persistenceScore: number; // compute_persistence(...) — carried, NOT a multiplier
  finalScore: number; // base × (1 + clamp(boost))
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
