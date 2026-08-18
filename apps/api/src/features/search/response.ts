import { users, type Database } from '@crosmos/db';
import type { StageRecorder } from '@crosmos/observability';
import type { TenantScope } from '../../lib/scope';
import { inArray } from 'drizzle-orm';
import { attachSourceContent } from './candidates';
import type { CandidateMemory, RetrievalResult } from './types';

interface SearchCandidateOut {
  memory_id: string;
  content: string;
  memory_type: string;
  score: number;
  source?: string | null;
  created_at: string;
  event_time: string | null;
  owner_name: string | null;
}

function buildResponse(
  ownerById: Map<number, string>,
  queryText: string,
  result: RetrievalResult,
  includeSource: boolean,
): { query: string; candidates: SearchCandidateOut[] } {
  if (result.candidates.length === 0) {
    return { query: queryText, candidates: [] };
  }
  const candidates = result.candidates.map((candidate: CandidateMemory) => {
    const response: SearchCandidateOut = {
      memory_id: candidate.uuid ?? String(candidate.memoryId),
      content: candidate.content,
      memory_type: candidate.memoryType,
      score: candidate.finalScore,
      created_at: candidate.createdAt.toISOString(),
      event_time: candidate.eventTime ? candidate.eventTime.toISOString() : null,
      owner_name: candidate.ownerUserId != null
        ? ownerById.get(candidate.ownerUserId) ?? null
        : null,
    };
    if (includeSource) response.source = candidate.sourceChunk ?? null;
    return response;
  });
  return { query: queryText, candidates };
}

export async function hydrateSearchResponse(input: {
  db: Database;
  scope: TenantScope;
  result: RetrievalResult;
  includeSource: boolean;
  queryText: string;
  stages: StageRecorder;
}) {
  const ownerIds = [
    ...new Set(
      input.result.candidates
        .map((candidate) => candidate.ownerUserId)
        .filter((id): id is number => id != null),
    ),
  ];
  const ownerRowsPromise = input.stages.time(
    'owner_name_load',
    {},
    () => ownerIds.length > 0
      ? input.db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, ownerIds))
      : Promise.resolve([]),
    (rows) => ({ inputCount: ownerIds.length, outputCount: rows.length }),
  );
  const sourceContentPromise =
    input.includeSource && input.result.candidates.length > 0
      ? input.stages.time(
          'source_content_load',
          {},
          () => attachSourceContent(input.db, input.scope, input.result.candidates),
          () => ({
            inputCount: input.result.candidates.length,
            outputCount: input.result.candidates.length,
          }),
        ).catch(() => undefined)
      : Promise.resolve();
  const [ownerRows] = await Promise.all([ownerRowsPromise, sourceContentPromise]);
  const ownerById = new Map(ownerRows.map((owner) => [owner.id, owner.name]));
  return input.stages.time(
    'search_response_build',
    {},
    async () => buildResponse(
      ownerById,
      input.queryText,
      input.result,
      input.includeSource,
    ),
    (built) => ({
      inputCount: input.result.candidates.length,
      outputCount: built.candidates.length,
    }),
  );
}
