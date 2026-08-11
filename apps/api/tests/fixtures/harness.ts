/**
 * The single shared ingest+retrieve routine used by BOTH the fixture capture
 * script and the baseline test.
 *
 * It exists because the two originally each rebuilt the loop, and they drifted:
 * the capture recorded an embedding for
 * `"... (happened in May 2026)"` while replay asked for
 * `"... (happened in June 2026)"`. The extraction LLM had supplied an
 * `event_time` on one path and not the other, so the temporal regex fallback
 * filled it differently — a one-word divergence that made every fixture after
 * it unreachable.
 *
 * Sharing the routine removes that whole class of bug: whatever the pipeline
 * does, capture and replay do the same thing to it. If they ever disagree
 * again, it is a real nondeterminism in the pipeline rather than a difference
 * between two hand-written harnesses.
 */
import type { Database } from '@crosmos/db';
import { sql } from 'drizzle-orm';
import type { MemoryVectorStore } from '@crosmos/test-support';
import { ingestSource } from '../../../ingestion/src/ingestion/pipeline';
import { retrieve } from '../../src/features/search/service';
import { CORPUS, QUERIES, type CorpusQuery } from './corpus';

/**
 * Frozen clock for scoring. Recency and persistence decay with wall-clock time,
 * so without this the same corpus scores differently seconds apart and an exact
 * baseline is impossible. Production is unaffected — it passes no clock.
 */
export const FROZEN_NOW = new Date('2026-06-01T12:00:00.000Z');

export interface HarnessScope {
  orgId: number;
  spaceId: number;
  userId: number;
}

export interface IngestedSession {
  sessionId: string;
  sourceId: number;
  memoryContents: string[];
  edgeCount: number;
  chunkCount: number;
}

/**
 * Ingest the whole fixture corpus through the REAL pipeline, in corpus order.
 *
 * Order matters and is deliberate: each source's Stage-1 dedup hint queries the
 * vectors written by earlier sources, so the corpus is a sequence, not a set.
 */
export async function ingestCorpus(options: {
  db: Database;
  scope: HarnessScope;
  llm: unknown;
  embedder: unknown;
  vectorStore: MemoryVectorStore;
  onSession?(session: IngestedSession): void;
}): Promise<IngestedSession[]> {
  const { db, scope, vectorStore } = options;
  const sessions: IngestedSession[] = [];

  for (const doc of CORPUS) {
    const [row] = await db.execute<{ id: number }>(sql`
      insert into sources (uuid, org_id, space_id, owner_user_id, visibility,
                           content_type, content, extraction_status, meta)
      values (gen_random_uuid(), ${scope.orgId}, ${scope.spaceId}, ${scope.userId},
              'org', ${doc.contentType}, ${doc.content}, 'pending',
              ${JSON.stringify({ session_id: doc.sessionId, date: doc.date })}::jsonb)
      returning id`);
    const sourceId = row!.id;

    const result = await ingestSource({
      db,
      scope,
      sourceId,
      llm: options.llm as never,
      embedder: options.embedder as never,
      vectorStore: vectorStore as never,
      // Serial chunks. Concurrent chunks share the mutable cross-chunk dedup set
      // and race entity resolution, so the same source can yield different facts
      // run to run — which makes a byte-exact baseline impossible. Production
      // keeps its concurrency; only this harness pins it.
      chunkConcurrency: 1,
    });

    await db.execute(
      sql`update sources set extraction_status='completed' where id=${sourceId}`,
    );

    const session: IngestedSession = {
      sessionId: doc.sessionId,
      sourceId,
      memoryContents: result.memories.map((m) => m.fact.content),
      edgeCount: result.edges.length,
      chunkCount: result.chunkCount,
    };
    sessions.push(session);
    options.onSession?.(session);
  }

  return sessions;
}

/** Run one corpus query through the REAL retrieval orchestrator. */
export async function runCorpusQuery(options: {
  db: Database;
  scope: HarnessScope;
  query: CorpusQuery;
  embedder: unknown;
  reranker: unknown;
  vectorStore: MemoryVectorStore;
}) {
  const { query } = options;
  return retrieve({
    query: {
      text: query.text,
      topK: query.topK ?? 10,
      candidatePool: 50,
      recencyBias: null,
      rerank: true,
      graph: true,
      diversify: query.diversify ?? false,
      includeSource: true,
    },
    scope: options.scope,
    deps: {
      db: options.db,
      embedder: options.embedder as never,
      reranker: options.reranker as never,
      vectorStore: options.vectorStore as never,
    },
    entitlements: null,
    now: FROZEN_NOW,
  });
}

/** Shape recorded in the baseline and compared against on replay. */
export interface BaselineCandidate {
  content: string;
  memoryType: string;
  finalScore: number;
  sessionId: string | null;
}

export function toBaselineCandidates(result: {
  candidates: Array<{
    content: string;
    memoryType: string;
    finalScore: number;
    sessionId: string | null;
  }>;
}): BaselineCandidate[] {
  return result.candidates.map((c) => ({
    content: c.content,
    memoryType: c.memoryType,
    finalScore: c.finalScore,
    sessionId: c.sessionId,
  }));
}

export { CORPUS, QUERIES };
