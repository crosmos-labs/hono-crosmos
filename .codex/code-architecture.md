# Code Architecture

## Monorepo Layout

```
apps/
  api/          Hono HTTP Worker
  ingestion/    Cloudflare Queue consumer Worker
packages/
  db/           Drizzle schema, migrations, createDb()
  ai/           Shared embedding and reranker clients
  types/        Cross-worker contracts and TenantScope
.codex/         Compact architecture and operations context
```

## API Worker

Entry point: `apps/api/src/index.ts`.

Mounted route groups:

- `/health`
- `/api/v1/auth`
- `/api/v1/auth/oauth`
- `/api/v1/orgs`
- `/api/v1/spaces`
- `/api/v1/sources`
- `/api/v1/conversations`
- `/api/v1/search`
- `/api/v1/jobs`
- OAuth server routes at `/oauth/*` and `/.well-known/oauth-authorization-server`
- `/openapi.json` and `/docs`

Feature structure:

- `features/auth`: JWT sessions, API keys, auth middleware.
- `features/oauth`: Google OAuth consumer plus OAuth 2.1 server routes for external connectors.
- `features/orgs`: org service, memberships, entitlements, quota checks.
- `features/spaces`: memory-space CRUD.
- `features/sources`: source CRUD and async ingestion enqueue.
- `features/conversations`: conversation segmentation into source batches.
- `features/search`: inline hybrid retrieval.
- `features/jobs`: ingestion job status.
- `integrations`: KV rate limiting, queue adapter, job store, email, embeddings, reranker.
- `lib`: scope, crypto, gate cache, shared Zod helpers.

Auth supports JWT bearer tokens and `csk_...` API keys. API keys are hashed and cached in KV; JWTs carry `active_org_id`. `requirePrincipal` resolves the org context used by feature routes.

## Ingestion Worker

Entry point: `apps/ingestion/src/index.ts`.

The worker handles Cloudflare Queue batches. Wrangler sets `max_batch_size = 1`, so one queue message is one ingestion job. A job can contain many source IDs.

Main modules:

- `process-ingestion.ts`: job-level orchestration, idempotency gates, retries, status rollup, usage recording.
- `ingestion/pipeline.ts`: single-source pipeline.
- `extractors/*`: memory extraction, graph extraction, normalization, temporal fallback, entity resolution.
- `ontology/*`: allowed entity and relation types.
- `prompts/*`: extraction prompts.
- `integrations/llm`: OpenRouter/OpenAI-compatible LLM adapters.
- `integrations/embeddings`: embedding adapter used by ingestion.

## Shared Packages

- `@crosmos/db` exports Drizzle schema and `createDb(connectionString)`.
- `@crosmos/types` defines `TenantScope`, ingestion queue message shape, and job result/status contracts.
- `@crosmos/ai` defines shared embedding/reranker ports and HTTP adapters.

## Database Shape

Core tables:

- Identity and auth: `users`, `organizations`, `organization_members`, `api_keys`, OAuth tables.
- Memory containers: `memory_spaces`, `sources`, `memories`.
- Knowledge graph: `entities`, `edges`, `memory_entities`, `source_memories`.
- Operations and metering: `ingestion_jobs`, `daily_usage`.

Drizzle is configured with `casing: 'snake_case'`, so TypeScript fields are camelCase while SQL columns remain snake_case.
