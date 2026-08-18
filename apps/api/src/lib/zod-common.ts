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
    fields: z.record(z.unknown()).optional(),
  })
  .openapi('ErrorResponse');

export const OrgRoleSchema = z.enum(['owner', 'admin', 'member']);
export const PlanSchema = z.enum(['free', 'developer', 'pro', 'enterprise']);

// Bounded offset pagination for list endpoints. `limit` defaults to 50, hard
// max 200; `offset` defaults to 0. Coerced from query strings.
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Caps for free-form user `meta` JSON that lands in Postgres. The global 10 MB
// body cap is far too generous for an opaque metadata blob — without these a
// single field could store multi-MB / deeply-nested JSON. 16 KB + 8 levels is
// plenty for real metadata.
const MAX_META_BYTES = 16 * 1024;
const MAX_META_DEPTH = 8;

function jsonDepth(value: unknown, depth = 0): number {
  // Stop descending once we've already exceeded the cap — also bounds recursion
  // on adversarially deep payloads.
  if (depth > MAX_META_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const v of value) max = Math.max(max, jsonDepth(v, depth + 1));
    return max;
  }
  if (value && typeof value === 'object') {
    let max = depth;
    for (const v of Object.values(value)) max = Math.max(max, jsonDepth(v, depth + 1));
    return max;
  }
  return depth;
}

/**
 * A free-form `meta` object with size + nesting-depth caps. Use for any
 * user-supplied metadata that is persisted verbatim (sources/spaces/
 * conversations). Apply `.nullable()` / `.optional()` at the call site as
 * needed.
 */
export const BoundedMetaSchema = z
  .record(z.unknown())
  .refine(
    (v) => {
      try {
        return new TextEncoder().encode(JSON.stringify(v)).length <= MAX_META_BYTES;
      } catch {
        return false;
      }
    },
    { message: `meta must serialize to at most ${MAX_META_BYTES} bytes` },
  )
  .refine((v) => jsonDepth(v) <= MAX_META_DEPTH, {
    message: `meta nesting must be at most ${MAX_META_DEPTH} levels deep`,
  });
