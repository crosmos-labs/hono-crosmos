import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

export const CreateSpaceSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().nullable().optional(),
    meta: z.record(z.unknown()).nullable().optional(),
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

export const QuotaExceededBodySchema = z
  .object({
    detail: z.object({
      error: z.literal('quota_exceeded'),
      key: z.string(),
      limit: z.number().int(),
      used: z.number().int(),
    }),
  })
  .openapi('QuotaExceededBody');
