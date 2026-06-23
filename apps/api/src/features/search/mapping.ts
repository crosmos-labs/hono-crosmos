import { type RankedCandidate, type RetrievalMemoryRow, SourceSignal } from './types';

/**
 * Build a `RankedCandidate` from a loaded memory row. Every signal emits
 * candidates with the same memory-derived fields; only `rank`, `score`, and
 * `source` differ. `sourceChunk`/`sourceId` are filled later by the
 * orchestrator's source-text attach step. Accepts the projected
 * `RetrievalMemoryRow` (the keyword signal passes a full `Memory`, which is a
 * superset and assignable).
 */
export function toRankedCandidate(
  m: RetrievalMemoryRow,
  rank: number,
  score: number,
  source: SourceSignal,
): RankedCandidate {
  return {
    memoryId: m.id,
    uuid: m.uuid,
    content: m.content,
    memoryType: m.memoryType,
    ownerUserId: m.ownerUserId,
    orgId: m.orgId,
    spaceId: m.spaceId,
    importanceScore: m.importanceScore,
    createdAt: m.createdAt,
    recordedAt: m.recordedAt,
    accessFrequency: m.accessFrequency,
    lastAccessedAt: m.lastAccessedAt,
    eventTime: m.eventTime,
    rank,
    score,
    source,
    sourceChunk: null,
    sourceId: null,
    sourceUuid: null,
    sessionId: null,
  };
}
