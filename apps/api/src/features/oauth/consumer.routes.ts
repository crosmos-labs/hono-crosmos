import {
  createTokenPair,
  InvalidTokenError,
  signFlowState,
  verifyFlowState,
} from '../auth/jwt';
import { tokenUrlSafe } from '../../lib/crypto';
import {
  OAuthAuthorizeQuerySchema,
  OAuthAuthorizeResponseSchema,
  OAuthCallbackRequestSchema,
  OAuthCallbackResponseSchema,
  OAuthProvidersSchema,
} from './schemas';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { createLogger } from '@crosmos/observability';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { errorEnvelope } from '../../lib/errors';
import { getEmailSender } from '../../integrations/email';
import { perIpRateLimit } from '../../integrations/rate-limit/ip';
import { waitUntilLogged } from '../../lib/runtime';
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  OAuthError,
} from './google';
import { getEarliestMembershipForUser } from '../orgs/memberships';
import { getOrCreateOauthUser } from './onboarding';

export const oauthConsumerRoutes = createApiApp();

const ErrorBody = z.object({ detail: z.string() }).openapi('OAuthErrorBody');
const STATE_TTL_SECONDS = 10 * 60; // 10 minutes

interface ConsumerState {
  v: 1;
  provider: string;
  redirect_uri: string;
  nonce: string;
}

oauthConsumerRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/providers',
    tags: ['oauth-consumer'],
    summary: 'List available OAuth providers',
    responses: {
      200: {
        description: 'Providers',
        content: { 'application/json': { schema: OAuthProvidersSchema } },
      },
    },
  }),
  (c) => c.json({ providers: ['google'] }, 200),
);

oauthConsumerRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{provider}/authorize',
    tags: ['oauth-consumer'],
    summary: 'Build OAuth authorize URL',
    middleware: [
      perIpRateLimit({ bucket: 'oauth-consumer-authorize', tier: 'standard' }),
    ] as const,
    request: {
      params: z.object({ provider: z.string() }),
      query: OAuthAuthorizeQuerySchema,
    },
    responses: {
      200: {
        description: 'Authorization URL + state',
        content: { 'application/json': { schema: OAuthAuthorizeResponseSchema } },
      },
      400: {
        description: 'Unsupported provider',
        content: { 'application/json': { schema: ErrorBody } },
      },
    },
  }),
  async (c) => {
    const { provider } = c.req.valid('param');
    const { redirect_uri } = c.req.valid('query');
    if (provider !== 'google') {
      throw new HTTPException(400, { message: `Unsupported provider: ${provider}` });
    }

    const stateClaims: ConsumerState = {
      v: 1,
      provider,
      redirect_uri,
      nonce: tokenUrlSafe(12),
    };
    const state = await signFlowState(
      c.env.JWT_SECRET,
      stateClaims as unknown as Record<string, unknown>,
      STATE_TTL_SECONDS,
    );

    const authorization_url = buildGoogleAuthorizationUrl({
      clientId: c.env.GOOGLE_CLIENT_ID,
      redirectUri: redirect_uri,
      state,
    });

    return c.json({ authorization_url, state }, 200);
  },
);

oauthConsumerRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{provider}/callback',
    tags: ['oauth-consumer'],
    summary: 'Exchange OAuth code for tokens',
    middleware: [
      perIpRateLimit({ bucket: 'oauth-consumer-callback', tier: 'standard' }),
    ] as const,
    request: {
      params: z.object({ provider: z.string() }),
      body: { content: { 'application/json': { schema: OAuthCallbackRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Token pair',
        content: { 'application/json': { schema: OAuthCallbackResponseSchema } },
      },
      400: {
        description: 'Bad request',
        content: { 'application/json': { schema: ErrorBody } },
      },
      401: {
        description: 'Invalid state or code',
        content: { 'application/json': { schema: ErrorBody } },
      },
    },
  }),
  async (c) => {
    const { provider } = c.req.valid('param');
    const { code, state, redirect_uri } = c.req.valid('json');
    if (provider !== 'google') {
      throw new HTTPException(400, { message: `Unsupported provider: ${provider}` });
    }

    // 1. Verify state
    let stateClaims: ConsumerState;
    try {
      stateClaims = await verifyFlowState<ConsumerState>(c.env.JWT_SECRET, state);
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        // Don't leak jose/library text to the client; log the real reason.
        createLogger({
          service: 'api',
          environment: c.env.ENVIRONMENT,
        }).warn('oauth.consumer_invalid_state', {
          reason: 'invalid_oauth_state',
          scope: 'oauth-consumer',
          error_name: err.name,
          error_message: err.message,
        });
        return c.json(
          errorEnvelope('Invalid OAuth state', {
            code: 'invalid_oauth_state',
            requestId: c.var.requestId,
          }),
          401,
        );
      }
      throw err;
    }
    if (stateClaims.provider !== provider || stateClaims.redirect_uri !== redirect_uri) {
      throw new HTTPException(401, { message: 'State does not match provider/redirect_uri' });
    }

    // 2. Exchange with Google
    let userInfo;
    try {
      userInfo = await exchangeGoogleCode({
        clientId: c.env.GOOGLE_CLIENT_ID,
        clientSecret: c.env.GOOGLE_CLIENT_SECRET,
        code,
        redirectUri: redirect_uri,
      });
    } catch (err) {
      if (err instanceof OAuthError) {
        // err.message embeds raw Google/jose upstream text — log it, return generic.
        createLogger({
          service: 'api',
          environment: c.env.ENVIRONMENT,
        }).warn('oauth.consumer_exchange_failed', {
          reason: 'oauth_exchange_failed',
          scope: 'oauth-consumer',
          error_name: err.name,
          error_message: err.message,
        });
        return c.json(
          errorEnvelope('OAuth exchange failed', {
            code: 'oauth_exchange_failed',
            requestId: c.var.requestId,
          }),
          401,
        );
      }
      throw err;
    }

    // 3. Get-or-create user
    const db = getDb(c);
    const result = await getOrCreateOauthUser(db, {
      provider: userInfo.provider,
      providerUserId: userInfo.providerUserId,
      email: userInfo.email,
      name: userInfo.name,
    });
    if (!result.user.isActive) {
      throw new HTTPException(401, { message: 'User account inactive' });
    }

    // 4. Determine active_org_id (new user = personal org; returning = earliest membership)
    let activeOrgId: number | null = result.org?.id ?? null;
    let activeOrgUuid: string | null = result.org?.uuid ?? null;
    if (activeOrgId == null) {
      const membership = await getEarliestMembershipForUser(db, result.user.id);
      activeOrgId = membership?.orgId ?? null;
      activeOrgUuid = membership?.orgUuid ?? null;
    }

    // 5. Mint tokens
    const pair = await createTokenPair(c.env.JWT_SECRET, result.user.id, {
      activeOrgId,
    });

    // 6. Fire welcome email for new users (non-blocking).
    // The adapter is a NoopEmailSender in environments without RESEND_API_KEY.
    if (result.isNewUser) {
      const email = getEmailSender(c.env);
      waitUntilLogged(
        c,
        createLogger({
          service: 'api',
          environment: c.env.ENVIRONMENT,
          base: {
            user_id: result.user.id,
          },
        }),
        'email.welcome_send_failed',
        email.sendWelcome({
          to: result.user.email,
          name: result.user.name,
        }),
        { stage: 'welcome_email', provider: 'resend' },
      );
    }

    return c.json(
      {
        user_id: result.user.uuid,
        email: result.user.email,
        name: result.user.name,
        access_token: pair.accessToken,
        refresh_token: pair.refreshToken,
        token_type: 'bearer' as const,
        is_new_user: result.isNewUser,
        default_space_id: result.defaultSpace?.uuid ?? null,
        active_org_id: activeOrgUuid,
      },
      200,
    );
  },
);
