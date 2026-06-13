import { z } from '@hono/zod-openapi';
import { UuidSchema } from '../../lib/zod-common';
import { TokenPairSchema } from '../auth/schemas';

export const OAuthCallbackResponseSchema = TokenPairSchema.extend({
  is_new_user: z.boolean(),
  default_space_id: UuidSchema.nullable(),
}).openapi('OAuthCallbackResponse');

export const OAuthProvidersSchema = z
  .object({ providers: z.array(z.string()) })
  .openapi('OAuthProviders');

export const OAuthAuthorizeQuerySchema = z.object({
  redirect_uri: z.string().url().max(2048),
});

export const OAuthAuthorizeResponseSchema = z
  .object({
    authorization_url: z.string().url(),
    state: z.string(),
  })
  .openapi('OAuthAuthorizeResponse');

export const OAuthCallbackRequestSchema = z
  .object({
    // Opaque provider authorization code and signed state JWT; capped to bound abuse.
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(2048),
    redirect_uri: z.string().url().max(2048),
  })
  .openapi('OAuthCallbackRequest');
