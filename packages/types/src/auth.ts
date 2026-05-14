import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from './common.js';

export const UserSchema = z
  .object({
    id: UuidSchema,
    email: z.string().email(),
    name: z.string(),
  })
  .openapi('User');

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

export const OAuthCallbackResponseSchema = TokenPairSchema.extend({
  is_new_user: z.boolean(),
  default_space_id: UuidSchema.nullable(),
}).openapi('OAuthCallbackResponse');

export const RefreshRequestSchema = z
  .object({ refresh_token: z.string() })
  .openapi('RefreshRequest');

export const LogoutRequestSchema = RefreshRequestSchema.openapi('LogoutRequest');

// API Keys
export const CreateApiKeySchema = z
  .object({
    name: z.string().min(1).max(255),
    expires_at: IsoDateTimeSchema.optional(),
  })
  .openapi('CreateApiKeyRequest');

export const ApiKeyCreatedSchema = z
  .object({
    key_id: UuidSchema,
    name: z.string(),
    key_prefix: z.string(),
    raw_key: z.string(),
    expires_at: IsoDateTimeSchema.nullable(),
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
  })
  .openapi('ApiKeyListItem');

export const ApiKeyListResponseSchema = z
  .object({ keys: z.array(ApiKeyListItemSchema) })
  .openapi('ApiKeyListResponse');

export const ApiKeyValidateResponseSchema = z
  .object({ valid: z.boolean(), key_prefix: z.string() })
  .openapi('ApiKeyValidateResponse');

// OAuth consumer
export const OAuthProvidersSchema = z
  .object({ providers: z.array(z.string()) })
  .openapi('OAuthProviders');

export const OAuthAuthorizeQuerySchema = z.object({
  redirect_uri: z.string().url(),
});

export const OAuthAuthorizeResponseSchema = z
  .object({
    authorization_url: z.string().url(),
    state: z.string(),
  })
  .openapi('OAuthAuthorizeResponse');

export const OAuthCallbackRequestSchema = z
  .object({
    code: z.string(),
    state: z.string(),
    redirect_uri: z.string().url(),
  })
  .openapi('OAuthCallbackRequest');
