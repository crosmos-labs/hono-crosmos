import { z } from '@hono/zod-openapi';
import { BoundedMetaSchema, IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';
import {
  MAX_CONTENT_LENGTH_PER_SOURCE,
  MAX_SOURCES_PER_REQUEST,
} from './constants';

/**
 * Accepted content types. Today only `text` + `markdown` are processed by
 * the pipeline; the others are stored verbatim so the producer can accept
 * them now and the pipeline can grow into them. Matches Python.
 */
const ContentTypeSchema = z
  .enum(['text', 'markdown', 'conversation', 'html', 'json', 'pdf', 'image', 'audio', 'video'])
  .openapi({ description: 'Today only `text` and `markdown` are processable.' });

const ExtractionStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'failed',
]);

export const VisibilitySchema = z.enum(['private', 'org']).openapi('MemoryVisibility');

const SourcePayloadSchema = z
  .object({
    content: z.string().min(1).max(MAX_CONTENT_LENGTH_PER_SOURCE),
    content_type: ContentTypeSchema.default('text'),
    role: z.string().min(1).max(50).optional(),
    visibility: VisibilitySchema.default('private'),
    meta: BoundedMetaSchema.nullable().optional(),
  })
  .openapi('SourcePayload');

export const IngestSourcesRequestSchema = z
  .object({
    space_id: UuidSchema,
    sources: z.array(SourcePayloadSchema).min(1).max(MAX_SOURCES_PER_REQUEST),
  })
  .openapi('IngestSourcesRequest');

export const IngestAcceptedResponseSchema = z
  .object({
    // First job's id, kept for backward compatibility. A request's sources are
    // split into one or more jobs of at most MAX_SOURCES_PER_JOB; poll each via
    // `jobs[].job_id`. For single-job requests (the common case) this equals
    // `jobs[0].job_id`.
    job_id: UuidSchema,
    status: z.literal('pending'),
    source_ids: z.array(UuidSchema),
    jobs: z
      .array(
        z.object({
          job_id: UuidSchema,
          source_ids: z.array(UuidSchema),
        }),
      )
      .openapi({ description: 'One entry per job the request was split into.' }),
  })
  .openapi('IngestAcceptedResponse');

export const SourceSummarySchema = z
  .object({
    id: UuidSchema,
    space_id: UuidSchema,
    content_type: z.string(),
    extraction_status: ExtractionStatusSchema,
    meta: z.record(z.unknown()).nullable(),
    token_count: z.number().int(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
    content_preview: z.string(),
  })
  .openapi('SourceSummary');

export const SourceResponseSchema = z
  .object({
    id: UuidSchema,
    space_id: UuidSchema,
    content: z.string(),
    content_type: z.string(),
    extraction_status: ExtractionStatusSchema,
    meta: z.record(z.unknown()).nullable(),
    token_count: z.number().int(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .openapi('SourceResponse');

export const SourceListResponseSchema = z
  .object({
    sources: z.array(SourceSummarySchema),
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .openapi('SourceListResponse');

export const ListSourcesQuerySchema = z.object({
  space_uuid: UuidSchema.optional(),
  space_id: UuidSchema.optional(),
  content_type: z.string().min(1).optional(),
  extraction_status: ExtractionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).superRefine((query, ctx) => {
  if (query.space_uuid && query.space_id && query.space_uuid !== query.space_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'space_uuid and space_id must match when both are provided',
      path: ['space_id'],
    });
  }
}).transform((query) => ({ ...query, space_id: query.space_uuid ?? query.space_id }));

export const SourceScopedQuerySchema = z
  .object({
    space_uuid: UuidSchema.optional(),
    space_id: UuidSchema.optional(),
  })
  .superRefine((query, ctx) => {
    if (!query.space_uuid && !query.space_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'space_uuid is required',
        path: ['space_uuid'],
      });
    }
    if (query.space_uuid && query.space_id && query.space_uuid !== query.space_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'space_uuid and space_id must match when both are provided',
        path: ['space_id'],
      });
    }
  })
  .transform((query) => ({ ...query, space_id: query.space_uuid ?? query.space_id! }))
  .openapi('SourceScopedQuery');

export const UpdateSourceVisibilityRequestSchema = z
  .object({
    visibility: VisibilitySchema,
  })
  .openapi('UpdateSourceVisibilityRequest');

export const SourceVisibilityResponseSchema = z
  .object({
    id: UuidSchema,
    visibility: VisibilitySchema,
    memories_updated: z.number().int().nonnegative(),
    edges_updated: z.number().int().nonnegative(),
  })
  .openapi('SourceVisibilityResponse');
