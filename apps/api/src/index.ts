import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import * as Sentry from '@sentry/cloudflare';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { Env, HonoEnv } from './bindings.js';

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
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT,
    tracesSampleRate: env.ENVIRONMENT === 'production' ? 0.1 : 1.0,
    enabled: Boolean(env.SENTRY_DSN),
  }),
  handler,
);
