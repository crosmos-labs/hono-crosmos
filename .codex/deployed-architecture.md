# Deployed Architecture

status: current
owner: engineering
last_verified: 2026-08-19
owns: production topology, provider selection, bindings, and domains
does_not_own: resource provisioning history, incident narrative, or roadmap

Production is the only supported deployed environment. The top-level Wrangler
configuration is the local-development default. Named staging configuration,
where still present, is not an assertion that staging secrets and resources are
provisioned or operational.

## Production provider matrix

| Concern | API Worker | Ingestion Worker | Admin Worker |
|---|---|---|---|
| Runtime | Cloudflare Workers/Hono | Cloudflare WorkerEntrypoint | Cloudflare Workers/Hono |
| Database | Hyperdrive to Neon Postgres | Hyperdrive to the same Neon database | Hyperdrive to the same Neon database |
| Vectors | Qdrant, derived memory/entity indexes | Qdrant reads and writes | None |
| Embeddings | OpenAI `text-embedding-3-small`, 1536 dimensions | OpenAI `text-embedding-3-small`, 1536 dimensions | None |
| LLM | None | OpenAI extraction | None |
| Reranker | ZeroEntropy `zerank-2`, enabled by default | None | None |
| Admission | `RateLimiterDO`; KV fallback/cache | Queue/RPC job claim | `AdminRateLimiterDO` |
| Metrics | Analytics Engine `crosmos_api` | Analytics Engine `crosmos_ingestion` | Analytics Engine `crosmos_admin` |

Voyage reranker code is retained for the in-progress migration. Changing the
production provider is a quality-affecting rollout and must not happen as a
side effect of maintainability work.

## Topology

```text
Clients
  -> api.crosmos.dev (API Worker, targeted to AWS us-east-1)
       -> RateLimiterDO / API_KEY_CACHE
       -> Hyperdrive -> Neon Postgres (authoritative state)
       -> OpenAI embeddings -> Qdrant ANN -> ZeroEntropy reranking
       -> ingestion-jobs queue (durable copy)
       -> IngestionWorker service binding (low-latency trigger)
            -> one Postgres job claim coordinates both delivery paths
            -> OpenAI extraction + embeddings
            -> Neon Postgres + Qdrant

Allowlisted operators
  -> Cloudflare Access -> admin.crosmos.dev
       -> Admin Worker -> AdminRateLimiterDO
       -> Hyperdrive -> Neon Postgres
       -> API_KEY_CACHE invalidation
```

All three production Workers export structured logs and traces; application
metrics write to their Analytics Engine datasets. API scheduled handlers run
billing reconciliation, ingestion recovery, cleanup, and space finalization.

## Production bindings

| Worker | Binding | Responsibility |
|---|---|---|
| API | `HYPERDRIVE` | Postgres pooling; no query cache for freshness-sensitive paths |
| API | `RATE_LIMITER` | Primary rate and search-concurrency admission |
| API | `API_KEY_CACHE` | API-key/entitlement cache and limiter fallback |
| API | `INGESTION_QUEUE` | Durable ingestion delivery |
| API | `INGESTION_SERVICE` | Low-latency ingestion RPC |
| API | `MEMORIES_INDEX`, `ENTITIES_INDEX`, `AI` | Available fallback adapters; inactive on the production Qdrant/OpenAI path |
| Ingestion | `HYPERDRIVE` | Authoritative source/job/memory writes |
| Ingestion | `INGESTION_QUEUE` | Queue consumer and continuation producer |
| Ingestion | `MEMORIES_INDEX`, `ENTITIES_INDEX`, `AI` | Available fallback adapters; inactive on the production Qdrant/OpenAI path |
| Admin | `HYPERDRIVE` | Operational reads and audited mutations |
| Admin | `ADMIN_RATE_LIMITER` | Per-IP admission |
| Admin | `API_KEY_CACHE` | Cache invalidation after audited changes |
| All | `ANALYTICS`, `CF_VERSION_METADATA` | Metrics and deploy attribution |

The API and ingestion Workers use targeted placement in `aws:us-east-1`, near
Neon and Qdrant. Qdrant is never an authorization authority: candidate IDs are
hydrated and visibility-filtered against Postgres.

## Domains and deployment

| Domain | Purpose |
|---|---|
| `api.crosmos.dev` | Current customer-facing API |
| `admin.crosmos.dev` | Cloudflare Access-gated operations API |

Deploy only with an explicit production environment:

```sh
bun run typecheck
bun run test
bun --filter @crosmos/api deploy:production
bun --filter @crosmos/ingestion deploy:production
bun --filter @crosmos/admin deploy:production
```

Contract changes to `@crosmos/types` that affect ingestion require coordinated
API and ingestion deployments. This document describes intended configuration;
verify the deployed Worker before claiming an in-progress rollout is live.
