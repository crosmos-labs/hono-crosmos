# Deployed Architecture

## Domains

| Domain | Purpose |
|---|---|
| `api.crosmos.dev` | Current customer-facing TypeScript/Hono production API deployed from this repository |
| `admin.crosmos.dev` | Cloudflare Access-gated admin API on its own Worker and authorization boundary |
| `staginghono.crosmos.dev` | TypeScript/Hono staging API |
| `hono.crosmos.dev` | Legacy migration hostname; not the current customer-facing production endpoint |

The Workers `production` environment in this repository is the live production
system serving `api.crosmos.dev`. The old Python repository at `../crosmos-mem`
is retained only as historical/reference code.

## Cloudflare Topology

```
Clients / agents
  -> crosmos-api Worker (Hono)
       -> Hyperdrive -> Neon Postgres
       -> KV for API-key cache, rate limits, search concurrency
       -> OpenAI embeddings / ZeroEntropy reranker
       -> Cloudflare Queue: ingestion-jobs
            -> crosmos-ingestion Worker
                 -> Hyperdrive -> Neon Postgres
                 -> OpenRouter/OpenAI extraction LLM
                 -> OpenAI embeddings

Allowlisted operators
  -> Cloudflare Access (`black-sea-b157.cloudflareaccess.com`)
       -> crosmos-admin Worker
            -> Hyperdrive -> Neon Postgres
            -> KV cache invalidation only (no ingestion queue/service binding)
```

## Workers

| Worker | Package | Role |
|---|---|---|
| `crosmos-api` / `crosmos-api-production` | `@crosmos/api` | Hono API gateway, auth, orgs, spaces, sources, conversations, jobs, retrieval/search, OAuth |
| `crosmos-ingestion` / `crosmos-ingestion-production` | `@crosmos/ingestion` | Cloudflare Queue consumer for source ingestion |
| `crosmos-admin` / `crosmos-admin-production` | `@crosmos/admin` | Access JWT + environment-allowlist gated operational reads and audited mutations |

The API worker has Smart Placement enabled so it runs close to the Hyperdrive/Neon origin for DB-heavy retrieval.

## Cloudflare Bindings

| Worker | Binding | Purpose |
|---|---|---|
| API | `HYPERDRIVE` | Neon Postgres connection pooling |
| API | `API_KEY_CACHE` | API-key cache, rate-limit counters, search concurrency counters |
| API | `INGESTION_QUEUE` | Producer for ingestion jobs |
| Ingestion | `HYPERDRIVE` | Same Neon Postgres database |
| Ingestion | queue consumer | Consumes `ingestion-jobs` in production and `ingestion-jobs-dev` in development |
| Admin | `HYPERDRIVE` | Same Neon Postgres database, isolated in a separate Worker |
| Admin | `API_KEY_CACHE` | API-key and entitlement cache invalidation after audited changes |
| Admin | `ADMIN_RATE_LIMITER` | Strongly consistent per-IP admission control |

Queue names:

- Development producer/consumer: `ingestion-jobs-dev`
- Development DLQ: `ingestion-jobs-dev-dlq`
- Production producer/consumer: `ingestion-jobs`
- Production DLQ: `ingestion-jobs-dlq`

## Deploy Commands

Run from the repo root:

```sh
bun run typecheck
bun --filter @crosmos/api deploy:production
bun --filter @crosmos/ingestion deploy:production
bun --filter @crosmos/admin deploy:production
```

Useful direct checks:

```sh
bun --filter @crosmos/api build
bun --filter @crosmos/ingestion build
bun --filter @crosmos/admin build
```

The root `bun run deploy` runs each package's default `deploy` script through Turbo, which targets the default Wrangler environment. Use the explicit `deploy:production` scripts above for production-env deploys.
