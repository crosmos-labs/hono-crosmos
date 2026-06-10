import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

const IngestionJobStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);

const JobResultSchema = z
  .object({
    source_ids: z.array(z.number().int()),
    failed_source_ids: z.array(z.number().int()),
    memory_count: z.number().int(),
    entity_count: z.number().int(),
    edge_count: z.number().int(),
    tokens_used: z.number().int(),
    source_errors: z.record(z.string()).optional(),
    error_message: z.string().optional(),
  })
  .openapi('IngestionJobResult');

export const JobResponseSchema = z
  .object({
    job_id: UuidSchema,
    status: IngestionJobStatusSchema,
    // Internal int IDs — matches Python so SDKs that already key off them
    // keep working. Users mostly poll via the UUID, but the source IDs are
    // useful for cross-referencing the per-source error map.
    source_ids: z.array(z.number().int()),
    result: JobResultSchema.nullable(),
    error_message: z.string().nullable(),
    created_at: IsoDateTimeSchema,
    started_at: IsoDateTimeSchema.nullable(),
    completed_at: IsoDateTimeSchema.nullable(),
  })
  .openapi('JobResponse');
