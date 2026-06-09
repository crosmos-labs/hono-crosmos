import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, OrgRoleSchema, PlanSchema, UuidSchema } from '../../lib/zod-common';

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

// `OrgResponse` in Python — same as the detail summary minus member_count/your_role.
export const OrganizationSchema = OrganizationSummarySchema.omit({
  member_count: true,
  your_role: true,
}).openapi('Organization');

// Mirrors UpdateOrgRequest validators in Python:
//   - name: trimmed, 1..255
//   - slug: 1..64, pattern ^[a-z0-9][a-z0-9-]*[a-z0-9]$
//   - billing_email: validated email or null to clear (we accept null; service
//     treats undefined as "leave alone")
export const SlugCollisionErrorSchema = z
  .object({
    detail: z.object({
      error: z.literal('slug_taken'),
      message: z.string(),
    }),
  })
  .openapi('SlugCollisionError');

export const UpdateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    slug: SlugSchema.optional(),
    billing_email: z.string().email().nullable().optional(),
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

export const MemberResponseSchema = z
  .object({
    user_id: UuidSchema,
    email: z.string().email(),
    name: z.string(),
    role: OrgRoleSchema,
    joined_at: IsoDateTimeSchema,
  })
  .openapi('MemberResponse');

export const MemberListResponseSchema = z
  .object({
    members: z.array(MemberResponseSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('MemberListResponse');

export const UpdateMemberRoleSchema = z
  .object({ role: z.enum(['admin', 'member']) })
  .openapi('UpdateMemberRoleRequest');
