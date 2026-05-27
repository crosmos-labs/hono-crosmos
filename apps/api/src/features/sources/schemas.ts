import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';
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
  .enum(['text', 'markdown', 'html', 'json', 'pdf', 'image', 'audio', 'video'])
  .openapi({ description: 'Today only `text` and `markdown` are processable.' });

const ExtractionStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'failed',
]);

const SourcePayloadSchema = z
  .object({
    content: z.string().min(1).max(MAX_CONTENT_LENGTH_PER_SOURCE),
    content_type: ContentTypeSchema.default('text'),
    role: z.string().min(1).max(50).optional(),
    sequence: z.number().int().nonnegative().optional(),
    meta: z.record(z.unknown()).nullable().optional(),
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
    job_id: UuidSchema,
    status: z.literal('pending'),
    source_ids: z.array(UuidSchema),
  })
  .openapi('IngestAcceptedResponse');

export const SourceSummarySchema = z
  .object({
    id: UuidSchema,
    space_id: UuidSchema,
    content_type: z.string(),
    sequence: z.number().int(),
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
    sequence: z.number().int(),
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
  space_id: UuidSchema.optional(),
  content_type: z.string().min(1).optional(),
  extraction_status: ExtractionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Structured error bodies used by ingestion routes. Matches the shapes in
 * .codex/pipelines.md — clients can branch on `detail.error`.
 */
export const RateLimitedBodySchema = z
  .object({
    detail: z.object({
      error: z.literal('rate_limited'),
      scope: z.enum(['rpm', 'day']),
      limit: z.number().int(),
      count: z.number().int(),
    }),
  })
  .openapi('RateLimitedBody');

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
