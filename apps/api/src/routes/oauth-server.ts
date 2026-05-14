import { InvalidTokenError } from '@crosmos/auth';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { Hono } from 'hono';
import type { HonoEnv } from '../bindings';
import { getDb } from '../db';
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  OAuthError,
} from '../services/google-oauth';
import { getOrCreateOauthUser } from '../services/onboarding';
import {
  createAuthorizationCode,
  createFlowState,
  decodeFlowState,
  exchangeAuthorizationCode,
  exchangeRefreshTokenOauth,
  getClient,
  hashClientSecret,
  OAuthServerError,
  registerClient,
  type FlowStateClaims,
} from '../services/oauth-server';

export const oauthServerRoutes = new OpenAPIHono<HonoEnv>();

// ── Metadata (RFC 8414) ────────────────────────────────────────────────

const MetadataSchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    registration_endpoint: z.string(),
    response_types_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.string()),
  })
  .openapi('OAuthAuthorizationServerMetadata');

oauthServerRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/.well-known/oauth-authorization-server',
    tags: ['oauth-server'],
    summary: 'OAuth 2.1 authorization server metadata',
    responses: {
      200: { description: 'Metadata', content: { 'application/json': { schema: MetadataSchema } } },
    },
  }),
  (c) => {
    const base = c.env.OAUTH_SERVER_BASE_URL.replace(/\/+$/, '');
    return c.json(
      {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        code_challenge_methods_supported: ['S256'],
      },
      200,
    );
  },
);

// ── Dynamic client registration (RFC 7591) ─────────────────────────────

const ClientRegistrationRequest = z
  .object({
    redirect_uris: z.array(z.string().url()).optional(),
    client_name: z.string().max(255).optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
  })
  .openapi('ClientRegistrationRequest');

const ClientRegistrationResponse = z
  .object({
    client_id: z.string(),
    client_secret: z.string().nullable(),
    client_id_issued_at: z.number().int(),
    client_secret_expires_at: z.literal(0),
    redirect_uris: z.array(z.string()),
    client_name: z.string().nullable(),
    grant_types: z.array(z.string()),
    response_types: z.array(z.string()),
    token_endpoint_auth_method: z.string(),
  })
  .openapi('ClientRegistrationResponse');

oauthServerRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/oauth/register',
    tags: ['oauth-server'],
    summary: 'Dynamic client registration',
    request: {
      body: { content: { 'application/json': { schema: ClientRegistrationRequest } } },
    },
    responses: {
      200: {
        description: 'Registered',
        content: { 'application/json': { schema: ClientRegistrationResponse } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const db = getDb(c);
    // MCP proxy clients are always public — force token_endpoint_auth_method=none.
    const { client, rawSecret } = await registerClient(db, {
      redirectUris: body.redirect_uris ?? [],
      clientName: body.client_name ?? null,
      grantTypes: body.grant_types ?? null,
      responseTypes: body.response_types ?? null,
      tokenEndpointAuthMethod: 'none',
    });

    return c.json(
      {
        client_id: client.clientId,
        client_secret: rawSecret,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_secret_expires_at: 0 as const,
        redirect_uris: client.redirectUris ?? [],
        client_name: client.clientName,
        grant_types: client.grantTypes ?? [],
        response_types: client.responseTypes ?? [],
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      },
      200,
    );
  },
);

// ── Authorize (302 → Google) and Callback (302 → client) ───────────────
// These are URL-redirect endpoints, not JSON. Use plain Hono — OpenAPIHono
// is awkward for redirects.

const redirectApp = new Hono<HonoEnv>();

function errorRedirect(
  redirectUri: string,
  error: string,
  description?: string,
  state?: string | null,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return Response.redirect(url.toString(), 302);
}

redirectApp.get('/oauth/authorize', async (c) => {
  const q = c.req.query();
  const response_type = q.response_type;
  const client_id = q.client_id;
  const redirect_uri = q.redirect_uri;
  const code_challenge = q.code_challenge;
  const code_challenge_method = q.code_challenge_method ?? 'S256';
  const state = q.state ?? null;
  const scope = q.scope ?? null;

  if (!client_id || !redirect_uri || !code_challenge) {
    return c.json({ error: 'invalid_request', error_description: 'Missing required params' }, 400);
  }

  const db = getDb(c);
  const client = await getClient(db, client_id);
  if (!client) {
    return c.json({ error: 'invalid_request', error_description: 'Unknown client_id' }, 400);
  }
  if (!client.redirectUris?.includes(redirect_uri)) {
    return c.json(
      { error: 'invalid_request', error_description: 'redirect_uri not registered for this client' },
      400,
    );
  }

  if (response_type !== 'code') {
    return errorRedirect(
      redirect_uri,
      'unsupported_response_type',
      "Only 'code' is supported",
      state,
    );
  }

  const flowState = await createFlowState(c.env.JWT_SECRET, {
    v: 1,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    scope,
  });

  const callbackUri = `${c.env.OAUTH_SERVER_BASE_URL.replace(/\/+$/, '')}/oauth/callback`;
  const authorizationUrl = buildGoogleAuthorizationUrl({
    clientId: c.env.GOOGLE_CLIENT_ID,
    redirectUri: callbackUri,
    state: flowState,
  });
  return Response.redirect(authorizationUrl, 302);
});

redirectApp.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const stateToken = c.req.query('state');
  if (!code || !stateToken) {
    return c.json({ detail: "Missing 'code' or 'state'" }, 400);
  }

  let flow: FlowStateClaims;
  try {
    flow = await decodeFlowState(c.env.JWT_SECRET, stateToken);
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      return c.json({ detail: 'Invalid or expired flow state' }, 400);
    }
    throw err;
  }

  const callbackUri = `${c.env.OAUTH_SERVER_BASE_URL.replace(/\/+$/, '')}/oauth/callback`;

  let userInfo;
  try {
    userInfo = await exchangeGoogleCode({
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri: callbackUri,
    });
  } catch (err) {
    if (err instanceof OAuthError) {
      return errorRedirect(flow.redirect_uri, 'access_denied', err.message, flow.state ?? null);
    }
    throw err;
  }

  const db = getDb(c);
  const { user } = await getOrCreateOauthUser(db, {
    provider: userInfo.provider,
    providerUserId: userInfo.providerUserId,
    email: userInfo.email,
    name: userInfo.name,
  });
  if (!user.isActive) {
    return errorRedirect(flow.redirect_uri, 'access_denied', 'Account is disabled', flow.state ?? null);
  }

  const authCode = await createAuthorizationCode(db, {
    clientId: flow.client_id,
    userId: user.id,
    redirectUri: flow.redirect_uri,
    codeChallenge: flow.code_challenge,
    codeChallengeMethod: flow.code_challenge_method,
    scope: flow.scope ?? null,
  });

  const dest = new URL(flow.redirect_uri);
  dest.searchParams.set('code', authCode);
  if (flow.state) dest.searchParams.set('state', flow.state);
  return Response.redirect(dest.toString(), 302);
});

// ── Token endpoint ─────────────────────────────────────────────────────

function tokenError(c: any, error: string, description?: string, status: 400 | 401 = 400): Response {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return c.json(body, status);
}

redirectApp.post('/oauth/token', async (c) => {
  const ctype = c.req.header('content-type') ?? '';
  let params: URLSearchParams;
  if (ctype.includes('application/x-www-form-urlencoded')) {
    params = new URLSearchParams(await c.req.text());
  } else {
    return tokenError(c, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }

  const grant_type = params.get('grant_type');
  const client_id = params.get('client_id');
  const client_secret = params.get('client_secret');

  if (!grant_type) return tokenError(c, 'invalid_request', "Missing 'grant_type'");
  if (!client_id) return tokenError(c, 'invalid_request', "Missing 'client_id'");

  const db = getDb(c);
  const client = await getClient(db, client_id);
  if (!client) return tokenError(c, 'invalid_client', 'Unknown client_id', 401);

  // For confidential clients, verify secret
  if (client.tokenEndpointAuthMethod !== 'none' && client.clientSecretHash) {
    if (!client_secret) return tokenError(c, 'invalid_client', 'Missing client_secret', 401);
    if ((await hashClientSecret(client_secret)) !== client.clientSecretHash) {
      return tokenError(c, 'invalid_client', 'Invalid client_secret', 401);
    }
  }

  try {
    if (grant_type === 'authorization_code') {
      const code = params.get('code');
      const redirect_uri = params.get('redirect_uri');
      if (!code) return tokenError(c, 'invalid_request', "Missing 'code' parameter");
      const tokens = await exchangeAuthorizationCode(db, c.env.JWT_SECRET, {
        code,
        clientId: client_id,
        redirectUri: redirect_uri,
      });
      return c.json(tokens, 200);
    }

    if (grant_type === 'refresh_token') {
      const refresh_token = params.get('refresh_token');
      if (!refresh_token) return tokenError(c, 'invalid_request', "Missing 'refresh_token' parameter");
      const tokens = await exchangeRefreshTokenOauth(db, c.env.JWT_SECRET, {
        refreshToken: refresh_token,
        clientId: client_id,
      });
      return c.json(tokens, 200);
    }

    return tokenError(c, 'unsupported_grant_type', `Unsupported: ${grant_type}`);
  } catch (err) {
    if (err instanceof OAuthServerError) {
      return tokenError(c, err.code, err.message);
    }
    throw err;
  }
});

// Expose the redirect-style sub-app so callers can mount it alongside the OpenAPI app.
export const oauthServerRedirectApp = redirectApp;
