import { z } from '@hono/zod-openapi';
import { UuidSchema } from '../../lib/zod-common';
import {
  MAX_CONTENT_LENGTH_PER_SOURCE,
  MAX_CONVERSATION_MESSAGES,
} from '../sources/constants';

const ConversationMessageSchema = z
  .object({
    role: z.string().min(1).max(50),
    content: z.string().min(1).max(MAX_CONTENT_LENGTH_PER_SOURCE),
  })
  .openapi('ConversationMessage');

export const IngestConversationRequestSchema = z
  .object({
    space_id: UuidSchema,
    messages: z
      .array(ConversationMessageSchema)
      .min(1)
      .max(MAX_CONVERSATION_MESSAGES),
    session_id: z.string().min(1).max(255).optional(),
    session_date: z.string().min(1).optional(),
    meta: z.record(z.unknown()).nullable().optional(),
  })
  .openapi('IngestConversationRequest');

export const IngestConversationResponseSchema = z
  .object({
    job_id: UuidSchema,
    status: z.literal('pending'),
    source_ids: z.array(UuidSchema),
  })
  .openapi('IngestConversationResponse');
