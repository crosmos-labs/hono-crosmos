/**
 * Edge creation from facts. Mirrors `app/engine/ingestion/edges.py`.
 *
 * Rules (pipeline.md §Stage 8):
 *  - Resolve subject/object via `nameToId`; skip if either is missing.
 *  - Skip self-edges (subject_id == object_id).
 *  - Dedup within this pipeline run by (subject_id, relation, object_id) —
 *    NOT across runs (the graph is monotonic).
 *  - confidence carries from the LLM.
 *  - valid_from = relation.validFrom ?? fact.eventTime
 *  - recorded_at = learnedTime
 */
import { edges, type Database, type Edge } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { casefold } from '../extractors/resolve-entity';
import type { NormalizedFact } from '../extractors/types';

export interface IngestedMemoryRef {
  memoryId: number;
  fact: NormalizedFact;
}

export interface IngestedEdge {
  edgeId: number;
  sourceEntityId: number;
  targetEntityId: number;
  relationType: string;
  memoryId: number;
}

export async function createEdgesFromFacts(
  db: Database,
  scope: TenantScope,
  ingested: IngestedMemoryRef[],
  nameToId: Map<string, number>,
  learnedTime: Date,
): Promise<IngestedEdge[]> {
  const rows: Array<{
    orgId: number;
    spaceId: number;
    sourceEntityId: number;
    targetEntityId: number;
    relationType: string;
    memoryId: number;
    validFrom: Date | null;
    confidence: number;
    recordedAt: Date;
  }> = [];

  const refsByRow: Array<{ memoryId: number; relationType: string }> = [];
  const seen = new Set<string>();

  for (const { memoryId, fact } of ingested) {
    for (const rel of fact.relations) {
      const subjId = nameToId.get(casefold(rel.subject));
      const objId = nameToId.get(casefold(rel.object));
      if (subjId === undefined || objId === undefined) continue;
      if (subjId === objId) continue;

      const key = `${subjId}|${rel.relation}|${objId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        sourceEntityId: subjId,
        targetEntityId: objId,
        relationType: rel.relation,
        memoryId,
        validFrom: rel.validFrom ?? fact.eventTime,
        confidence: rel.confidence,
        recordedAt: learnedTime,
      });
      refsByRow.push({ memoryId, relationType: rel.relation });
    }
  }

  if (rows.length === 0) return [];

  const inserted: Edge[] = await db.insert(edges).values(rows).returning();
  return inserted.map((e) => ({
    edgeId: e.id,
    sourceEntityId: e.sourceEntityId,
    targetEntityId: e.targetEntityId,
    relationType: e.relationType,
    memoryId: e.memoryId!,
  }));
}
