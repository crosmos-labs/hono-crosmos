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

// Keyset pagination on (joinedAt, userId). `cursor` is an opaque base64url
// token encoding the last seen `{ joinedAt, userId }`; `limit` defaults to 50,
// capped at 100.
export const MemberListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(256).optional(),
  })
  .openapi('MemberListQuery');

export const UpdateMemberRoleSchema = z
  .object({ role: z.enum(['admin', 'member']) })
  .openapi('UpdateMemberRoleRequest');

export const CreateInviteSchema = z
  .object({
    email: z.string().email(),
    role: z.enum(['admin', 'member']).default('member'),
  })
  .openapi('CreateInviteRequest');

export const InviteResponseSchema = z
  .object({
    id: UuidSchema,
    email: z.string().email(),
    role: z.enum(['admin', 'member']),
    invited_by: UuidSchema,
    expires_at: IsoDateTimeSchema,
    status: z.enum(['pending', 'expired', 'accepted']),
  })
  .openapi('InviteResponse');

export const InviteListResponseSchema = z
  .object({ invites: z.array(InviteResponseSchema) })
  .openapi('InviteListResponse');

export const AcceptInviteSchema = z
  .object({ token: z.string().min(20).max(128) })
  .openapi('AcceptInviteRequest');

export const AcceptInviteResponseSchema = z
  .object({
    org: OrganizationSchema,
    role: z.enum(['admin', 'member']),
  })
  .openapi('AcceptInviteResponse');

export const InvitePreviewResponseSchema = z
  .object({
    org_name: z.string(),
    inviter_name: z.string().nullable(),
    role: z.enum(['admin', 'member']),
    email: z.string().email(),
    expires_at: IsoDateTimeSchema,
  })
  .openapi('InvitePreviewResponse');
