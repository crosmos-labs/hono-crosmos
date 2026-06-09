import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

export const CreateGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    slug: SlugSchema.optional(),
  })
  .openapi('CreateVisibilityGroupRequest');

export const UpdateGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    slug: SlugSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.slug !== undefined, {
    message: 'provide at least one of: name, slug',
  })
  .openapi('UpdateVisibilityGroupRequest');

export const GroupSchema = z
  .object({
    id: UuidSchema,
    slug: z.string(),
    name: z.string(),
    member_count: z.number().int().nonnegative(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .openapi('VisibilityGroup');

export const GroupListSchema = z
  .object({ groups: z.array(GroupSchema) })
  .openapi('VisibilityGroupList');

export const GroupMemberSchema = z
  .object({
    user_id: UuidSchema,
    email: z.string().email(),
    name: z.string(),
  })
  .openapi('VisibilityGroupMember');

export const GroupMemberListSchema = z
  .object({ members: z.array(GroupMemberSchema) })
  .openapi('VisibilityGroupMemberList');

export const CreateGrantSchema = z
  .object({
    viewer_group_id: UuidSchema,
    subject_group_id: UuidSchema,
  })
  .openapi('CreateVisibilityGrantRequest');

export const GrantSchema = z
  .object({
    id: UuidSchema,
    viewer_group_id: UuidSchema,
    viewer_group_slug: z.string(),
    subject_group_id: UuidSchema,
    subject_group_slug: z.string(),
    created_at: IsoDateTimeSchema,
  })
  .openapi('VisibilityGrant');

export const GrantListSchema = z
  .object({ grants: z.array(GrantSchema) })
  .openapi('VisibilityGrantList');

export const VisiblePrincipalSchema = z
  .object({
    user_id: UuidSchema,
    email: z.string().email(),
    name: z.string(),
  })
  .openapi('VisiblePrincipal');

export const GrantImpactSchema = z
  .object({
    viewer_group_id: UuidSchema,
    subject_group_id: UuidSchema,
    newly_visible: z.array(VisiblePrincipalSchema),
  })
  .openapi('VisibilityGrantImpact');

export const VisibilityPreviewSchema = z
  .object({
    user_id: UuidSchema,
    visibility_enabled: z.boolean(),
    visible_users: z.array(VisiblePrincipalSchema),
  })
  .openapi('VisibilityPreview');

export const UpdateVisibilitySettingsSchema = z
  .object({ enabled: z.boolean() })
  .openapi('UpdateVisibilitySettingsRequest');

export const VisibilitySettingsSchema = z
  .object({ visibility_enabled: z.boolean() })
  .openapi('VisibilitySettings');
