import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

export const EntityResponseSchema = z
  .object({
    id: UuidSchema,
    space_id: UuidSchema,
    name: z.string(),
    entity_type: z.string().nullable(),
    edge_count: z.number().int(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .openapi('EntityResponse');

export const EntityMemorySchema = z
  .object({
    memory_id: UuidSchema,
    content: z.string(),
    memory_type: z.string(),
    created_at: IsoDateTimeSchema,
  })
  .openapi('EntityMemory');

export const EntityDetailResponseSchema = EntityResponseSchema.extend({
  memories: z.array(EntityMemorySchema),
}).openapi('EntityDetailResponse');

export const EntityListResponseSchema = z
  .object({
    entities: z.array(EntityResponseSchema),
    total: z.number().int().nonnegative(),
  })
  .openapi('EntityListResponse');

export const EntityListQuerySchema = z
  .object({
    space_id: UuidSchema,
    entity_type: z.string().optional(),
    q: z.string().optional(),
    sort_by: z.enum(['name', 'edge_count', 'created_at']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('EntityListQuery');

export const EntityDetailQuerySchema = z
  .object({ space_id: UuidSchema })
  .openapi('EntityDetailQuery');
