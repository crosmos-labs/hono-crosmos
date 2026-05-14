# API Gateway — Setup & Development Guide

This guide covers everything you need to build, test, and deploy the API Gateway worker. Assumes zero prior Cloudflare Workers experience.

## Prerequisites

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install Wrangler (Cloudflare CLI)
bun add -g wrangler

# Login to Cloudflare
wrangler login
```

You'll need:
- A Cloudflare account (free tier is fine to start)
- A NeonDB project (you already have one)
- A Resend account for emails
- Google OAuth credentials (you already have these)

---

## Project Initialization

```bash
# Create monorepo
mkdir crosmos-workers && cd crosmos-workers
bun init -y

# Set up Turborepo
bun add -D turbo
mkdir -p apps/api packages/db packages/auth packages/types
```

### Root `package.json`

```json
{
  "name": "crosmos-workers",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "deploy": "turbo deploy",
    "db:generate": "turbo db:generate",
    "db:migrate": "turbo db:migrate"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.4.0"
  }
}
```

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": {
      "cache": false,
      "persistent": true
    },
    "build": {
      "outputs": ["dist/**"]
    },
    "deploy": {
      "dependsOn": ["build"]
    }
  }
}
```

---

## API Gateway Worker Setup

```bash
cd apps/api
bun init -y
bun add hono @hono/zod-validator @hono/zod-openapi @hono/swagger-ui zod
bun add drizzle-orm postgres
bun add jose
bun add @sentry/cloudflare
bun add -D wrangler @cloudflare/workers-types drizzle-kit typescript
```

### `apps/api/wrangler.toml`

```toml
name = "crosmos-api"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Run with: wrangler dev
[dev]
port = 8787

# Hyperdrive binding for NeonDB
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id-here"

# KV namespace for API key cache
[[kv_namespaces]]
binding = "API_KEY_CACHE"
id = "your-kv-namespace-id-here"

# Queue binding for ingestion
[[queues.producers]]
binding = "INGESTION_QUEUE"
queue = "ingestion-jobs"

# Environment variables (non-secret)
[vars]
ENVIRONMENT = "development"
OAUTH_SERVER_BASE_URL = "http://localhost:8787"

# Production environment
[env.production]
[env.production.vars]
ENVIRONMENT = "production"
OAUTH_SERVER_BASE_URL = "https://api.crosmos.ai"
```

### `apps/api/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

---

## Environment Variables / Secrets

### Non-secret vars (in `wrangler.toml`)
```toml
ENVIRONMENT = "development"
OAUTH_SERVER_BASE_URL = "http://localhost:8787"
```

### Secrets (set via Wrangler CLI)

```bash
# JWT signing secret
wrangler secret put JWT_SECRET

# Google OAuth
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

# Resend
wrangler secret put RESEND_API_KEY

# Sentry
wrangler secret put SENTRY_DSN

# Polar (for billing webhooks)
wrangler secret put POLAR_WEBHOOK_SECRET
```

### Local secrets (`.dev.vars`)

For local development, create `.dev.vars` (gitignored):

```
JWT_SECRET=your-local-jwt-secret-min-32-chars
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
RESEND_API_KEY=re_xxx
SENTRY_DSN=https://xxx@sentry.io/xxx
POLAR_WEBHOOK_SECRET=xxx
DATABASE_URL=postgresql://user:pass@host/db
```

### TypeScript bindings

```typescript
// apps/api/src/bindings.ts
export interface Env {
  // Bindings
  HYPERDRIVE: Hyperdrive;
  API_KEY_CACHE: KVNamespace;
  INGESTION_QUEUE: Queue;
  
  // Vars
  ENVIRONMENT: 'development' | 'production';
  OAUTH_SERVER_BASE_URL: string;
  
  // Secrets
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
  SENTRY_DSN: string;
  POLAR_WEBHOOK_SECRET: string;
}
```

---

## Hyperdrive Setup (NeonDB Connection)

Hyperdrive is Cloudflare's connection pooler. It eliminates cold-start DB connections.

```bash
# Create Hyperdrive config pointing to NeonDB
wrangler hyperdrive create crosmos-db \
  --connection-string="postgresql://user:pass@your-neon-host/crosmos"

# Output:
# 🎉 Created Hyperdrive: crosmos-db
# id: abcd1234...
```

Add the `id` to `wrangler.toml` under `[[hyperdrive]]`.

### Using Hyperdrive

```typescript
// apps/api/src/db.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from './bindings';

export function createDb(env: Env) {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,  // Workers can have multiple concurrent requests
    fetch_types: false,  // Faster startup
  });
  return drizzle(sql);
}
```

---

## KV Namespace Setup (API Key Cache)

```bash
# Create KV namespace
wrangler kv namespace create API_KEY_CACHE

# Output:
# 🌀 Creating namespace with title "crosmos-api-API_KEY_CACHE"
# ✨ Success!
# Add the following to your configuration file:
# [[kv_namespaces]]
# binding = "API_KEY_CACHE"
# id = "abcd1234..."
```

Add the `id` to `wrangler.toml`.

### Using KV

```typescript
// Cache lookup
const cached = await env.API_KEY_CACHE.get(`apikey:${hash}`, 'json');

// Cache write with TTL
await env.API_KEY_CACHE.put(
  `apikey:${hash}`,
  JSON.stringify({ user_id, org_id }),
  { expirationTtl: 300 }  // 5 minutes
);
```

---

## Drizzle Migration Setup

### `packages/db/drizzle.config.ts`

```typescript
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/*',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
```

### Workflow

```bash
# 1. Define schema in packages/db/src/schema/users.ts
# 2. Generate migration SQL
bun drizzle-kit generate

# 3. Apply to NeonDB (direct connection, not through Hyperdrive)
bun drizzle-kit migrate
```

**Note:** Migrations run via direct NeonDB connection, not Hyperdrive. Set `DATABASE_URL` in your shell or `.env`.

---

## Local Development

```bash
# Start the API Gateway worker
cd apps/api
bun run wrangler dev

# Output:
# ⎔ Starting local server...
# [wrangler:info] Ready on http://localhost:8787
```

### What `wrangler dev` does:

- Runs your Worker in **Miniflare** (local Workers runtime)
- Reads secrets from `.dev.vars`
- Hot reloads on file changes
- Hyperdrive connects directly to NeonDB locally (no pooling)
- KV uses local SQLite storage

### Testing endpoints

```bash
# Health check
curl http://localhost:8787/health

# OAuth login flow
open http://localhost:8787/api/v1/auth/oauth/google/authorize?redirect_uri=http://localhost:3000/callback

# With API key
curl -H "Authorization: Bearer csk_xxx" http://localhost:8787/api/v1/auth/me
```

---

## API Documentation (OpenAPI / Swagger)

Hono has first-class OpenAPI support via `@hono/zod-openapi`. Schemas auto-generate Swagger docs.

### Setup

```typescript
// apps/api/src/index.ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';

const app = new OpenAPIHono<{ Bindings: Env }>();

// Swagger UI at /docs
app.get('/docs', swaggerUI({ url: '/openapi.json' }));

// OpenAPI spec at /openapi.json
app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Crosmos API',
    version: '1.0.0',
  },
});

export default app;
```

### Defining routes with auto-docs

```typescript
import { createRoute, z } from '@hono/zod-openapi';

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  expires_at: z.string().datetime().optional(),
}).openapi('CreateApiKeyRequest');

const ApiKeyResponseSchema = z.object({
  key_id: z.string().uuid(),
  raw_key: z.string(),
  key_prefix: z.string(),
}).openapi('ApiKeyResponse');

const createApiKeyRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/keys',
  request: {
    body: {
      content: {
        'application/json': { schema: CreateApiKeySchema },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': { schema: ApiKeyResponseSchema },
      },
      description: 'API key created',
    },
  },
});

app.openapi(createApiKeyRoute, async (c) => {
  const { name, expires_at } = c.req.valid('json');
  // ... handler logic
  return c.json({ key_id, raw_key, key_prefix }, 201);
});
```

Visit `http://localhost:8787/docs` to see the Swagger UI.

---

## Sentry Integration

```typescript
// apps/api/src/index.ts
import * as Sentry from '@sentry/cloudflare';

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT,
    tracesSampleRate: 0.1,
  }),
  app  // your Hono app
);
```

---

## CORS Configuration

```typescript
import { cors } from 'hono/cors';

app.use('/*', cors({
  origin: ['http://localhost:3000', 'https://app.crosmos.ai'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  credentials: true,
}));
```

---

## Error Handling

```typescript
import { HTTPException } from 'hono/http-exception';

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ detail: err.message }, err.status);
  }
  
  // Log to Sentry
  Sentry.captureException(err);
  
  return c.json({ detail: 'Internal server error' }, 500);
});

// Throw in handlers
throw new HTTPException(401, { message: 'Invalid token' });
```

---

## Testing Locally with curl

```bash
# Get OAuth URL
curl "http://localhost:8787/api/v1/auth/oauth/google/authorize?redirect_uri=http://localhost:3000/callback"

# After Google redirects back, exchange code
curl -X POST http://localhost:8787/api/v1/auth/oauth/google/callback \
  -H "Content-Type: application/json" \
  -d '{
    "code": "google_auth_code",
    "state": "state_from_authorize",
    "redirect_uri": "http://localhost:3000/callback"
  }'

# Use access token
curl http://localhost:8787/api/v1/auth/me \
  -H "Authorization: Bearer <access_token>"

# Create API key
curl -X POST http://localhost:8787/api/v1/auth/keys \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-key"}'

# Use API key
curl http://localhost:8787/api/v1/auth/me \
  -H "Authorization: Bearer csk_abc123..."
```

---

## Deployment

### Manual deployment

```bash
cd apps/api

# Deploy to staging
wrangler deploy --env staging

# Deploy to production
wrangler deploy --env production
```

### CI/CD with GitHub Actions

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build
      
      - name: Deploy API Gateway
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: apps/api
          command: deploy --env production
```

You'll need to set these GitHub secrets:
- `CLOUDFLARE_API_TOKEN` — Create at dash.cloudflare.com/profile/api-tokens
- `CLOUDFLARE_ACCOUNT_ID` — Found in Cloudflare dashboard URL

---

## Custom Domain Setup

After first deploy, your Worker is at `crosmos-api.{your-subdomain}.workers.dev`. To use `api.crosmos.ai`:

1. Add domain to Cloudflare (if not already)
2. In Worker settings → Triggers → Add Custom Domain → `api.crosmos.ai`
3. Cloudflare handles DNS + SSL automatically

---

## Monitoring & Logs

```bash
# Tail logs in real-time
wrangler tail

# Tail production logs
wrangler tail --env production

# Filter by status code
wrangler tail --status error
```

Cloudflare dashboard also provides:
- Request analytics
- Error rates
- Latency percentiles
- Sentry catches exceptions

---

## Common Gotchas

| Issue | Fix |
|-------|-----|
| `Cannot find name 'process'` | Add `nodejs_compat` compatibility flag |
| Hyperdrive timeout in dev | Falls back to direct NeonDB connection — slower locally |
| KV cache miss locally | Local KV is ephemeral — clears on restart |
| CORS errors from browser | Check `cors()` middleware origins |
| `node:crypto` not found | Workers has Web Crypto API instead (`crypto.subtle`) |
| OAuth redirect loop | `OAUTH_SERVER_BASE_URL` must match exactly |

---

## Quick Start Checklist

- [ ] `wrangler login`
- [ ] Create Hyperdrive: `wrangler hyperdrive create crosmos-db --connection-string=...`
- [ ] Create KV: `wrangler kv namespace create API_KEY_CACHE`
- [ ] Add IDs to `wrangler.toml`
- [ ] Set secrets: `wrangler secret put JWT_SECRET` (and others)
- [ ] Create `.dev.vars` for local dev
- [ ] Run migrations: `bun drizzle-kit migrate`
- [ ] Start dev server: `bun run wrangler dev`
- [ ] Visit `http://localhost:8787/docs` for Swagger UI
- [ ] Deploy: `wrangler deploy`

---

## Useful Links

- [Hono docs](https://hono.dev)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
- [Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/)
- [Drizzle ORM docs](https://orm.drizzle.team)
- [Wrangler CLI reference](https://developers.cloudflare.com/workers/wrangler/commands/)
- [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)
