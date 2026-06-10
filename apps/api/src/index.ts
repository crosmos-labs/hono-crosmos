import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger } from '@crosmos/observability';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from './bindings';
import { authRoutes } from './features/auth/routes';
import { billingRoutes, billingWebhookRoutes } from './features/billing/routes';
import { runBillingReconciliation } from './features/billing/reconcile';
import { conversationRoutes } from './features/conversations/routes';
import { entityRoutes } from './features/entities/routes';
import { graphRoutes } from './features/graph/routes';
import { jobRoutes } from './features/jobs/routes';
import { memoryRoutes } from './features/memories/routes';
import { oauthConsumerRoutes } from './features/oauth/consumer.routes';
import {
  oauthServerRedirectApp,
  oauthServerRoutes,
} from './features/oauth/server.routes';
import { orgRoutes } from './features/orgs/routes';
import { searchRoutes } from './features/search/routes';
import { sourceRoutes } from './features/sources/routes';
import { spaceRoutes } from './features/spaces/routes';
import { usageRoutes } from './features/usage/routes';
import { visibilityRoutes } from './features/visibility/routes';

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

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  await next();
  c.header('X-Request-Id', requestId);
});

app.onError((err, c) => {
  const requestId = c.var.requestId ?? crypto.randomUUID();
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    res.headers.set('X-Request-Id', requestId);
    if (res.headers.get('content-type')?.includes('application/json')) return res;
    return c.json(
      { detail: err.message },
      err.status,
      { 'X-Request-Id': requestId },
    );
  }
  createLogger({
    service: 'api',
    environment: c.env.ENVIRONMENT,
    base: { request_id: requestId },
  }).error('api.unhandled_error', {}, err);
  return c.json(
    { detail: 'Internal server error', request_id: requestId },
    500,
    { 'X-Request-Id': requestId },
  );
});

app.get('/health', (c) =>
  c.json({ status: 'ok', environment: c.env.ENVIRONMENT, ts: Date.now() }),
);

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/auth/oauth', oauthConsumerRoutes);
app.route('/api/v1/orgs', orgRoutes);
app.route('/api/v1/orgs', visibilityRoutes);
app.route('/api/v1/spaces', spaceRoutes);
app.route('/api/v1/sources', sourceRoutes);
app.route('/api/v1/memories', memoryRoutes);
app.route('/api/v1/entities', entityRoutes);
app.route('/api/v1/graph', graphRoutes);
app.route('/api/v1/search', searchRoutes);
app.route('/api/v1/conversations', conversationRoutes);
app.route('/api/v1/jobs', jobRoutes);
app.route('/api/v1/usage', usageRoutes);
app.route('/api/v1/billing', billingRoutes);
app.route('/webhooks', billingWebhookRoutes);
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

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: HonoEnv['Bindings']) {
    await runBillingReconciliation(env);
  },
};
