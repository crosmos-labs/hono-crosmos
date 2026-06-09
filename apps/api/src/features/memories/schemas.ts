import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

export const MemoryResponseSchema = z
  .object({
    id: UuidSchema,
    space_id: UuidSchema,
    content: z.string(),
    memory_type: z.string(),
    importance_score: z.number().nullable(),
    event_time: IsoDateTimeSchema.nullable(),
    meta: z.record(z.unknown()).nullable(),
    access_frequency: z.number().int(),
    last_accessed_at: IsoDateTimeSchema,
    forgotten_at: IsoDateTimeSchema.nullable(),
    created_at: IsoDateTimeSchema,
  })
  .openapi('MemoryResponse');

export const MemoryListResponseSchema = z
  .object({
    memories: z.array(MemoryResponseSchema),
    count: z.number().int().nonnegative(),
  })
  .openapi('MemoryListResponse');

export const MemoryListQuerySchema = z
  .object({
    space_id: UuidSchema,
    memory_type: z.enum(['viewpoint', 'semantic', 'episode', 'inference']).optional(),
    sort_by: z
      .enum([
        'created_at',
        'importance_score',
        'event_time',
        'last_accessed_at',
        'access_frequency',
      ])
      .default('created_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('MemoryListQuery');

export const SpaceScopedQuerySchema = z
  .object({ space_id: UuidSchema })
  .openapi('SpaceScopedQuery');
