# Deployed Architecture

## Domains

| Domain | Purpose |
|---|---|
| `hono.crosmos.dev` | Cloudflare Workers TypeScript/Hono deployment used for active development/migration validation |
| `api.crosmos.dev` | Current customer-facing Python production API, in `../crosmos-mem` |

The Workers `production` environment is real Cloudflare production infrastructure, but functionally this repo is still the development/migration target until traffic moves from `api.crosmos.dev`.

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
```

## Workers

| Worker | Package | Role |
|---|---|---|
| `crosmos-api` / `crosmos-api-production` | `@crosmos/api` | Hono API gateway, auth, orgs, spaces, sources, conversations, jobs, retrieval/search, OAuth |
| `crosmos-ingestion` / `crosmos-ingestion-production` | `@crosmos/ingestion` | Cloudflare Queue consumer for source ingestion |

The API worker has Smart Placement enabled so it runs close to the Hyperdrive/Neon origin for DB-heavy retrieval.

## Cloudflare Bindings

| Worker | Binding | Purpose |
|---|---|---|
| API | `HYPERDRIVE` | Neon Postgres connection pooling |
| API | `API_KEY_CACHE` | API-key cache, rate-limit counters, search concurrency counters |
| API | `INGESTION_QUEUE` | Producer for ingestion jobs |
| Ingestion | `HYPERDRIVE` | Same Neon Postgres database |
| Ingestion | queue consumer | Consumes `ingestion-jobs` in production and `ingestion-jobs-dev` in development |

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
```

Useful direct checks:

```sh
bun --filter @crosmos/api build
bun --filter @crosmos/ingestion build
```

The root `bun run deploy` runs each package's default `deploy` script through Turbo, which targets the default Wrangler environment. Use the explicit `deploy:production` scripts above for production-env deploys.
