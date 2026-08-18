import { z } from '@hono/zod-openapi';
import { BoundedMetaSchema, IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

export const CreateSpaceSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().nullable().optional(),
    meta: BoundedMetaSchema.nullable().optional(),
  })
  .openapi('CreateSpaceRequest');

export const SpaceSchema = z
  .object({
    id: UuidSchema,
    org_id: UuidSchema,
    name: z.string(),
    description: z.string().nullable(),
    meta: z.record(z.unknown()).nullable(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .openapi('Space');

export const SpaceListResponseSchema = z
  .object({
    spaces: z.array(SpaceSchema),
    total: z.number().int().nonnegative(),
  })
  .openapi('SpaceListResponse');

export const SpaceUsageQuerySchema = z
  .object({
    start_date: z.string().date().optional(),
    end_date: z.string().date().optional(),
  })
  .refine(
    (q) => !q.start_date || !q.end_date || q.start_date <= q.end_date,
    { message: 'start_date must be on or before end_date', path: ['start_date'] },
  )
  .openapi('SpaceUsageQuery');

export const SpaceUsageResponseSchema = z
  .object({
    space_id: UuidSchema,
    period_start: z.string().date(),
    period_end: z.string().date(),
    tokens_ingested: z.number().int().nonnegative(),
    search_queries: z.number().int().nonnegative(),
  })
  .openapi('SpaceUsageResponse');
