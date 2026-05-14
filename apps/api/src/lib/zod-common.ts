import { z } from '@hono/zod-openapi';

export const UuidSchema = z.string().uuid().openapi({ format: 'uuid' });

export const IsoDateTimeSchema = z.string().datetime();

export const ErrorResponseSchema = z
  .object({
    detail: z.union([
      z.string(),
      z.object({ code: z.string(), message: z.string() }),
    ]),
  })
  .openapi('ErrorResponse');

export const OrgRoleSchema = z.enum(['owner', 'admin', 'member']);
export const PlanSchema = z.enum(['free', 'developer', 'pro', 'enterprise']);
