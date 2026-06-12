import { z } from '@hono/zod-openapi';

export const UuidSchema = z.string().uuid().openapi({ format: 'uuid' });

export const IsoDateTimeSchema = z.string().datetime();

// Canonical error envelope (see lib/errors.ts). `detail` is ALWAYS a string;
// structured data lives in `code` / `fields`; `request_id` is always present
// on error responses.
export const ErrorResponseSchema = z
  .object({
    detail: z.string(),
    code: z.string().optional(),
    request_id: z.string().optional(),
    fields: z.unknown().optional(),
  })
  .openapi('ErrorResponse');

export const OrgRoleSchema = z.enum(['owner', 'admin', 'member']);
export const PlanSchema = z.enum(['free', 'developer', 'pro', 'enterprise']);
