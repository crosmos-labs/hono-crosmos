import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import * as Sentry from '@sentry/cloudflare';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { Env, HonoEnv } from './bindings';
import { authRoutes } from './features/auth/routes';
import { conversationRoutes } from './features/conversations/routes';
import { jobRoutes } from './features/jobs/routes';
import { oauthConsumerRoutes } from './features/oauth/consumer.routes';
import {
  oauthServerRedirectApp,
  oauthServerRoutes,
} from './features/oauth/server.routes';
import { orgRoutes } from './features/orgs/routes';
import { searchRoutes } from './features/search/routes';
import { sourceRoutes } from './features/sources/routes';
import { spaceRoutes } from './features/spaces/routes';

const app = new OpenAPIHono<HonoEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ detail: result.error.flatten() }, 400);
    }
  },
});

app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
    maxAge: 600,
  }),
);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    if (res.headers.get('content-type')?.includes('application/json')) return res;
    return c.json({ detail: err.message }, err.status);
  }
  if (c.env.SENTRY_DSN) {
    try {
      Sentry.captureException(err);
    } catch {
      // ignore Sentry init failures
    }
  }
  console.error('Unhandled error', err);
  return c.json({ detail: 'Internal server error' }, 500);
});

app.get('/health', (c) =>
  c.json({ status: 'ok', environment: c.env.ENVIRONMENT, ts: Date.now() }),
);

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/auth/oauth', oauthConsumerRoutes);
app.route('/api/v1/orgs', orgRoutes);
app.route('/api/v1/spaces', spaceRoutes);
app.route('/api/v1/sources', sourceRoutes);
app.route('/api/v1/search', searchRoutes);
app.route('/api/v1/conversations', conversationRoutes);
app.route('/api/v1/jobs', jobRoutes);
app.route('/', oauthServerRoutes);
app.route('/', oauthServerRedirectApp);

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'JWT access token or API key (csk_...)',
});

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Crosmos API', version: '0.1.0' },
  servers: [{ url: '/' }],
});

app.get(
  '/docs',
  swaggerUI({ url: '/openapi.json', title: 'Crosmos API Docs' }),
);

app.notFound((c) => c.json({ detail: 'Not found' }, 404));

const handler = {
  fetch: app.fetch,
};

export default Sentry.withSentry(
  (env) => {
    const e = env as Env | undefined;
    return {
      dsn: e?.SENTRY_DSN ?? '',
      environment: e?.ENVIRONMENT ?? 'development',
      tracesSampleRate: e?.ENVIRONMENT === 'production' ? 0.1 : 1.0,
      enabled: Boolean(e?.SENTRY_DSN),
    };
  },
  handler,
);
