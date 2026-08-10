import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger, createMetrics, durationMs } from '@crosmos/observability';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from './bindings';
import { errorEnvelope, isAppError } from './lib/errors';
import { classifyDependencyError } from './lib/dependency-errors';
import { runSweep, sweepMetrics } from './lib/sweep-retry';
import {
  NO_RETRY_HEADERS,
  noRetryUntilHeaders,
  retryAfterHeaders,
} from './lib/retry-hints';
import { authRoutes } from './features/auth/routes';
import { billingRoutes, billingWebhookRoutes } from './features/billing/routes';
import { runBillingReconciliation } from './features/billing/reconcile';
import { runMaintenanceCleanup } from './features/maintenance/cleanup';
import { runSpaceFinalization } from './features/maintenance/finalize-spaces';
import { reapStaleJobs, runIngestionRedrive } from './features/maintenance/redrive';
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
import { adminRoutes } from './features/admin/reembed';
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

// Baseline security headers on every response. HSTS tells browsers to pin
// HTTPS for this host (and its subdomains) for two years — closes the
// "Domains without HSTS" finding for api.crosmos.dev. `includeSubDomains` is
// safe here because api.crosmos.dev has no sub-subdomains; `preload` is left
// off deliberately (that's an apex-domain commitment, not the API's to make).
// nosniff / frame-deny / referrer are cheap hardening for a JSON API + docs UI.
app.use('*', async (c, next) => {
  await next();
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
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
  const logger = createLogger({
    service: 'api',
    environment: c.env.ENVIRONMENT,
    base: { request_id: requestId },
  });

  // Known dependency failures are NOT application defects. Classifying them here
  // covers every route at once, and turns the incident's dominant error path —
  // 4,616 provider-budget rejections that all became generic 500s — into a
  // precise 503 that alerting can distinguish and clients can act on.
  const dependency = classifyDependencyError(err);
  if (dependency) {
    logger.error(
      'api.dependency_unavailable',
      {
        code: dependency.code,
        dependency: dependency.dependency,
        error_category: 'external_service',
        status_code: dependency.status,
        deterministic: dependency.deterministic,
        retry_after_seconds: dependency.retryAfterSeconds,
      },
      err,
    );
    return c.json(
      errorEnvelope(dependency.detail, { code: dependency.code, requestId }),
      dependency.status,
      {
        'X-Request-Id': requestId,
        // A deterministic outage cannot be repaired by retrying, so suppress the
        // client's automatic retry outright and give it the provider's own
        // recovery time. A transient drop keeps normal retry behavior, just
        // paced by Retry-After instead of immediate.
        ...(dependency.deterministic
          ? noRetryUntilHeaders(dependency.retryAfterSeconds)
          : retryAfterHeaders(dependency.retryAfterSeconds)),
      },
    );
  }

  logger.error('api.unhandled_error', {}, err);
  return c.json(
    errorEnvelope('Internal server error', { code: 'internal_error', requestId }),
    500,
    {
      'X-Request-Id': requestId,
      // An unexpected defect is not made better by an immediate second attempt,
      // and under load the retry is what converts a fault into a cascade.
      ...NO_RETRY_HEADERS,
    },
  );
});

app.get('/health', (c) =>
  c.json({ status: 'ok', environment: c.env.ENVIRONMENT, ts: Date.now() }),
);

// RFC 9116 security contact. Served on the API host so researchers have a
// disclosure channel; the apex marketing site (crosmos.dev) should serve its
// own copy too. Update `Expires` before it lapses (scanners flag stale files).
app.get('/.well-known/security.txt', (c) =>
  c.text(
    [
      'Contact: mailto:security@crosmos.dev',
      'Expires: 2027-01-01T00:00:00.000Z',
      'Preferred-Languages: en',
      'Canonical: https://api.crosmos.dev/.well-known/security.txt',
      '',
    ].join('\n'),
    200,
    { 'Content-Type': 'text/plain; charset=utf-8' },
  ),
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
app.route('/api/v1/_admin', adminRoutes);
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
  async scheduled(controller: ScheduledController, env: HonoEnv['Bindings']) {
    const logger = createLogger({ service: 'api', environment: env.ENVIRONMENT });

    // The ingestion re-drive runs on a frequent cron (every 15 min) so wedged
    // sources recover quickly; billing + retention sweeps stay daily. Branch on
    // the firing schedule so the heavy daily sweeps don't run every 15 min.
    const isDaily = controller.cron === '17 3 * * *';

    // Every sweep goes through `runSweep`, which keeps them isolated (it never
    // throws, so one failure cannot block the others), surfaces failures rather
    // than losing them, and adds a bounded retry for CLASSIFIED TRANSIENT
    // database errors only. Without that retry a single dropped connection
    // deferred a sweep's whole workload to the next cron — 15 minutes for the
    // re-drive, a full day for the daily sweeps. Capacity exhaustion and every
    // unclassified error still get exactly one attempt.
    const metrics = sweepMetrics(env.ANALYTICS, env.ENVIRONMENT);
    const sweep = <T>(name: string, run: () => Promise<T>) =>
      runSweep(name, logger, run, { metrics });

    // Reap orphaned jobs first (cheap CAS update): flip jobs that crashed
    // mid-flight from `processing`/`pending` to `failed` so they stop pinning
    // the per-user pending cap + the global queue-depth gate and become terminal
    // for cleanup. The windowed counts already self-heal the gates; this makes
    // the rows' status reflect reality. See issue #3.
    const reap = await sweep('jobs_reap', () => reapStaleJobs(env));
    if (reap.status === 'succeeded' && (reap.value ?? 0) > 0) {
      logger.info('cron.jobs_reaped', {
        trigger: 'cron',
        cron: controller.cron,
        jobs_reaped: reap.value,
        attempts: reap.attempts,
      });
    }

    const redrive = await sweep('ingestion_redrive', () => runIngestionRedrive(env));
    if (redrive.status === 'succeeded') {
      logger.info('cron.ingestion_redrive', {
        trigger: 'cron',
        cron: controller.cron,
        jobs_created: redrive.value!.jobsCreated,
        sources_requeued: redrive.value!.sourcesRequeued,
        attempts: redrive.attempts,
      });
    }

    if (!isDaily) return;

    const billing = await sweep('billing_reconciliation', () =>
      runBillingReconciliation(env),
    );
    if (billing.status === 'succeeded') {
      logger.info('cron.billing_reconciliation', {
        trigger: 'cron',
        cron: controller.cron,
        subscriptions_expired: billing.value!.expired,
        checkouts_abandoned: billing.value!.abandoned,
        attempts: billing.attempts,
      });
    }

    // Physical cleanup of tombstoned spaces. Daily, and a no-op unless
    // SPACE_FINALIZER_ENABLED is set — see `runSpaceFinalization`.
    const finalize = await sweep('space_finalization', () => runSpaceFinalization(env));
    if (finalize.status === 'succeeded' && !finalize.value!.disabled) {
      logger.info('cron.space_finalization', {
        trigger: 'cron',
        cron: controller.cron,
        candidates: finalize.value!.candidates,
        deleted_count: finalize.value!.finalized,
        skipped_no_owner: finalize.value!.skippedActiveJobs,
        failed_job_count: finalize.value!.failedVectorPurge,
        attempts: finalize.attempts,
      });
    }

    const cleanup = await sweep('maintenance_cleanup', () => runMaintenanceCleanup(env));
    if (cleanup.status === 'succeeded') {
      const deleted = cleanup.value!;
      logger.info('cron.maintenance_cleanup', {
        trigger: 'cron',
        cron: controller.cron,
        deleted_count:
          deleted.authorizationCodes +
          deleted.revokedRefreshTokens +
          deleted.ingestionJobs +
          deleted.billingEvents +
          deleted.dailyUsage,
        attempts: cleanup.attempts,
      });
    }
  },
};
