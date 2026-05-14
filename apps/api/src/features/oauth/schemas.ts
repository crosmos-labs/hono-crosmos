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
