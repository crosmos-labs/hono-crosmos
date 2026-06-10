import type { Memory } from '@crosmos/db';
import { type RankedCandidate, SourceSignal } from './types';

/**
 * Build a `RankedCandidate` from a loaded `Memory` row. Every signal emits
 * candidates with the same memory-derived fields; only `rank`, `score`, and
 * `source` differ. `sourceChunk`/`sourceId` are filled later by the
 * orchestrator's source-text attach step.
 */
export function toRankedCandidate(
  m: Memory,
  rank: number,
  score: number,
  source: SourceSignal,
): RankedCandidate {
  return {
    memoryId: m.id,
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
  };
}
