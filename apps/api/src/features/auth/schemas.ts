import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

export const UserSchema = z
  .object({
    user_id: UuidSchema,
    email: z.string().email(),
    name: z.string(),
    org: z
      .object({
        id: UuidSchema,
        slug: z.string(),
        name: z.string(),
        role: z.enum(['owner', 'admin', 'member']),
      })
      .nullable(),
  })
  .openapi('MeResponse');

export const UpdateUserSchema = z
  .object({
    name: z.string().min(1).max(255).trim().optional(),
  })
  .openapi('UpdateUserRequest');

export const TokenPairSchema = z
  .object({
    user_id: UuidSchema,
    email: z.string().email(),
    name: z.string(),
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.literal('bearer'),
    active_org_id: UuidSchema.nullable(),
  })
  .openapi('TokenPair');

export const RefreshRequestSchema = z
  .object({
    // Opaque signed JWT; cap well above real token sizes to bound abuse.
    refresh_token: z.string().min(1).max(512),
    active_org_id: UuidSchema.nullable().optional(),
  })
  .openapi('RefreshRequest');

export const LogoutRequestSchema = RefreshRequestSchema.openapi('LogoutRequest');

// API Keys
export const CreateApiKeySchema = z
  .object({
    name: z.string().min(1).max(255),
    expires_at: IsoDateTimeSchema.optional(),
    // Optional: pin this key to a single memory space. When set, the key can
    // only ingest/search/read within that space — safe to hand to one
    // end-user's client. Omit for a full org-wide key (default, unchanged).
    space_id: UuidSchema.optional(),
  })
  .openapi('CreateApiKeyRequest');

export const ApiKeyCreatedSchema = z
  .object({
    key_id: UuidSchema,
    name: z.string(),
    key_prefix: z.string(),
    raw_key: z.string(),
    expires_at: IsoDateTimeSchema.nullable(),
    // The space this key is scoped to, or null for an org-wide key.
    space_id: UuidSchema.nullable(),
  })
  .openapi('ApiKeyCreatedResponse');

export const ApiKeyListItemSchema = z
  .object({
    key_id: UuidSchema,
    name: z.string(),
    key_prefix: z.string(),
    is_active: z.boolean(),
    expires_at: IsoDateTimeSchema.nullable(),
    last_used_at: IsoDateTimeSchema.nullable(),
    created_at: IsoDateTimeSchema,
    // The space this key is scoped to, or null for an org-wide key.
    space_id: UuidSchema.nullable(),
  })
  .openapi('ApiKeyListItem');

export const ApiKeyListResponseSchema = z
  .object({ keys: z.array(ApiKeyListItemSchema) })
  .openapi('ApiKeyListResponse');

export const ApiKeyValidateResponseSchema = z
  .object({ valid: z.boolean(), key_prefix: z.string() })
  .openapi('ApiKeyValidateResponse');

export const SetActiveOrgSchema = z
  .object({ org_id: UuidSchema })
  .openapi('SetActiveOrgRequest');

export const SetActiveOrgResponseSchema = z
  .object({
    access_token: z.string(),
    active_org_id: UuidSchema,
  })
  .openapi('SetActiveOrgResponse');
