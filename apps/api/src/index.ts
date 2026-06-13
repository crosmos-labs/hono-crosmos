import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger, createMetrics, durationMs } from '@crosmos/observability';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from './bindings';
import { errorEnvelope, isAppError } from './lib/errors';
import { authRoutes } from './features/auth/routes';
import { billingRoutes, billingWebhookRoutes } from './features/billing/routes';
import { runBillingReconciliation } from './features/billing/reconcile';
import { runMaintenanceCleanup } from './features/maintenance/cleanup';
// Durable Object class for the per-IP rate limiter — must be exported from the
// worker entry so the runtime can instantiate it.
export { RateLimiterDO } from './integrations/rate-limit/limiter-do';
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

// Max request body, in bytes. Bounds memory/transfer abuse (the audit flagged
// ~50MB conversation-ingest bodies being accepted). 10MB is generous for text
// ingestion while rejecting pathological payloads with a 413 before JSON.parse.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const app = new OpenAPIHono<HonoEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        errorEnvelope('Validation failed', {
          code: 'validation_error',
          requestId: c.var.requestId,
          fields: result.error.flatten(),
        }),
        400,
      );
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

// Cap request body size early (413 before any handler/JSON.parse runs).
app.use(
  '*',
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        errorEnvelope('Request body too large', {
          code: 'body_too_large',
          requestId: c.var.requestId,
        }),
        413,
      ),
  }),
);

// Access log: one structured record per request (method, path, status,
// duration, principal). Gives baseline coverage for routes that don't log
// themselves and for 4xx responses, which previously left no trace.
app.use('*', async (c, next) => {
  const start = performance.now();
  await next();
  const logger = createLogger({
    service: 'api',
    environment: c.env.ENVIRONMENT,
    base: { request_id: c.var.requestId },
  });
  logger.info('http.request', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status_code: c.res.status,
    duration_ms: durationMs(start),
    ...(c.var.activeOrgId != null ? { org_id: c.var.activeOrgId } : {}),
    ...(c.var.userId != null ? { user_id: c.var.userId } : {}),
  });
  createMetrics(c.env.ANALYTICS, {
    service: 'api',
    environment: c.env.ENVIRONMENT,
  }).count('http_request', {
    // blobs: method, path, status; doubles: duration_ms
    tags: [c.req.method, new URL(c.req.url).pathname, String(c.res.status)],
    values: [durationMs(start)],
    index: 'http_request',
  });
});

app.onError((err, c) => {
  const requestId = c.var.requestId ?? crypto.randomUUID();
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    res.headers.set('X-Request-Id', requestId);
    // Custom Response bodies (e.g. the per-IP limiter) already carry the
    // canonical envelope — pass them through untouched.
    if (res.headers.get('content-type')?.includes('application/json')) return res;
    return c.json(
      errorEnvelope(err.message, { requestId }),
      err.status,
      { 'X-Request-Id': requestId },
    );
  }
  // Expected domain conditions (not-found / conflict / forbidden) thrown as
  // AppError map to their status + machine code instead of a generic 500 —
  // keeps real 500s meaningful for alerting.
  if (isAppError(err)) {
    return c.json(
      errorEnvelope(err.message, { code: err.code, requestId }),
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
    errorEnvelope('Internal server error', { code: 'internal_error', requestId }),
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

app.notFound((c) =>
  c.json(
    errorEnvelope('Not found', { code: 'not_found', requestId: c.var.requestId }),
    404,
  ),
);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: HonoEnv['Bindings']) {
    const logger = createLogger({ service: 'api', environment: env.ENVIRONMENT });
    // Both sweeps are independent — isolate failures so one can't block the
    // other, and so a cron failure is surfaced rather than silently lost.
    try {
      await runBillingReconciliation(env);
    } catch (err) {
      logger.error('cron.billing_reconciliation_failed', { trigger: 'cron' }, err);
    }
    try {
      const deleted = await runMaintenanceCleanup(env);
      logger.info('cron.maintenance_cleanup', {
        trigger: 'cron',
        deleted_count:
          deleted.authorizationCodes +
          deleted.revokedRefreshTokens +
          deleted.ingestionJobs +
          deleted.billingEvents +
          deleted.dailyUsage,
      });
    } catch (err) {
      logger.error('cron.maintenance_cleanup_failed', { trigger: 'cron' }, err);
    }
  },
};
