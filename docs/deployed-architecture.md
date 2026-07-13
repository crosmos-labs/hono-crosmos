# Deployed Architecture

## Domains

| Domain | Purpose |
|---|---|
| `hono.crosmos.dev` | Cloudflare Workers TypeScript/Hono deployment used for active development and migration validation |
| `api.crosmos.dev` | Current customer-facing Python production API, in `../crosmos-mem` |

The Workers `production` environment is real Cloudflare production infrastructure, but functionally this repo is still the development/migration target until traffic moves from `api.crosmos.dev`.

## Production stack — source of truth

> If you're asking "what does prod actually use?", this table is the answer.
> Verified 2026-06-20 from `[env.production.vars]` in both `wrangler.toml` files
> **and** the deployed `wrangler secret list` (QDRANT_API_KEY, ZEROENTROPY_API_KEY,
> OPENAI_API_KEY, OPENROUTER_API_KEY are all set on both workers).

| Concern | Production provider | Set by |
|---|---|---|
| Vector store | **Qdrant** (cloud cluster, us-east-1) | `VECTOR_STORE=qdrant` + `QDRANT_URL` / `QDRANT_API_KEY` |
| Embeddings | **OpenAI** `text-embedding-3-small` @ **1536-dim** | `EMBEDDINGS_PROVIDER=openai` + `EMBEDDING_DIMENSIONS=1536` |
| Reranker | **ZeroEntropy** `zerank-2` | `RERANKER_PROVIDER=zeroentropy` |
| Extraction LLM | **OpenAI direct** `gpt-4.1-mini` (was OpenRouter until 2026-07-13, dropped after its credit pool 402-failed prod ingestions) | `LLM_PROVIDER=openai` (reuses `OPENAI_API_KEY`) |
| Relational + graph | **Neon Postgres** via Hyperdrive | `[[hyperdrive]]` |

> **NOT used in prod, despite being declared in `wrangler.toml`:** the `[ai]`
> **Workers AI** binding and the `[[vectorize]]` indexes (`crosmos-*-v3`) are
> **dormant** — they exist as bindings but the runtime `VECTOR_STORE` / provider
> vars route every read and write to Qdrant + OpenAI + ZeroEntropy. They are
> swappable fallbacks (the providers sit behind `@crosmos/ai` + `@crosmos/vector`
> ports), not the live path. Do not describe prod as "Workers AI" or "Vectorize".
>
> The top-level (non-prod) `[vars]` default to `workers-ai` / `vectorize` for a
> bare `wrangler dev`; the local benchmark overrides them to the prod providers
> via `.dev.vars` (see `docs/benchmarking.md`).

## Cloudflare Topology

```
Clients / agents
  -> crosmos-api Worker (Hono)
       -> Hyperdrive -> Neon Postgres
       -> KV for API-key cache, rate limits, search concurrency
       -> OpenAI embeddings / ZeroEntropy reranker
       -> Qdrant (us-east-1) for vector search
       -> Cloudflare Queue: ingestion-jobs
            -> crosmos-ingestion Worker
                 -> Hyperdrive -> Neon Postgres
                 -> OpenAI extraction LLM (gpt-4.1-mini)
                 -> OpenAI embeddings -> Qdrant (vector writes)
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
