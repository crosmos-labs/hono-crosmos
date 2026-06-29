import { z } from '@hono/zod-openapi';
import { UuidSchema } from '../../lib/zod-common';

/**
 * Search API contract — port of `app/api/search/schemas.py`. Field names and
 * defaults match Python exactly (snake_case on the wire). See .codex/pipelines.md.
 */
export const SearchRequestSchema = z
  .object({
    query: z.string().min(1).max(3000).openapi({ description: 'The search query text' }),
    space_id: UuidSchema.openapi({ description: 'The memory space to search within' }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .openapi({ description: 'Max number of results to return' }),
    recency_bias: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .default(null)
      .openapi({
        description:
          'Override recency weighting. 0.0 disables recency, higher values favor recent memories.',
      }),
    rerank: z
      .boolean()
      .default(true)
      .openapi({ description: 'Apply cross-encoder reranking. Disable for lower latency.' }),
    graph: z
      .boolean()
      .default(true)
      .openapi({ description: 'Include graph traversal signal. Disable for semantic + keyword only.' }),
    diversify: z
      .boolean()
      .default(false)
      .openapi({ description: 'Apply MMR diversity post-rerank. Enable for broad/summarization intents.' }),
    include_source: z
      .boolean()
      .default(true)
      .openapi({ description: 'Include original source text in results.' }),
  })
  .openapi('SearchRequest');

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const MemoryCandidateSchema = z
  .object({
    memory_id: UuidSchema, // mapped from internal int id
    content: z.string(),
    memory_type: z.string(),
    score: z.number(), // == CandidateMemory.finalScore
    // Present iff include_source=true; omitted entirely (key popped) otherwise.
    source: z.string().nullable().optional(),
    created_at: z.string(), // iso8601
    event_time: z.string().nullable(), // iso8601 | null
    owner_name: z.string().nullable(), // visibility attribution in shared spaces
  })
  .openapi('MemoryCandidate');

export const SearchResponseSchema = z
  .object({
    query: z.string(),
    candidates: z.array(MemoryCandidateSchema),
  })
  .openapi('SearchResponse');
