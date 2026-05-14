import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, OrgRoleSchema, PlanSchema, UuidSchema } from './common.js';

export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

export const OrganizationSummarySchema = z
  .object({
    id: UuidSchema,
    slug: z.string(),
    name: z.string(),
    plan: PlanSchema,
    billing_email: z.string().email().nullable(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
    member_count: z.number().int().nonnegative(),
    your_role: OrgRoleSchema,
  })
  .openapi('OrganizationSummary');

export const OrganizationListResponseSchema = z
  .object({
    orgs: z.array(OrganizationSummarySchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('OrganizationListResponse');

export const OrganizationSchema = OrganizationSummarySchema.omit({
  member_count: true,
  your_role: true,
}).openapi('Organization');

export const UpdateOrganizationSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    slug: SlugSchema.optional(),
    billing_email: z.string().email().optional(),
  })
  .openapi('UpdateOrganizationRequest');

export const EntitlementsResponseSchema = z
  .object({
    plan: PlanSchema,
    entitlements: z.record(z.any()),
    usage_this_month: z.object({
      tokens_ingested: z.number().int().nonnegative(),
      search_queries: z.number().int().nonnegative(),
    }),
  })
  .openapi('EntitlementsResponse');
