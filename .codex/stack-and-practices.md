# Stack And Practices

status: current
owner: engineering
last_verified: 2026-08-19
owns: runtime, tooling, coding conventions, and cross-cutting invariants
does_not_own: deployment resource identifiers or detailed pipeline sequence

## Stack

- Package manager: Bun (`packageManager`: `bun@1.3.5`).
- Monorepo/task runner: Bun workspaces + Turborepo.
- Runtime: Cloudflare Workers with `nodejs_compat`.
- HTTP framework: Hono + `@hono/zod-openapi`.
- Database: Neon Postgres through Cloudflare Hyperdrive. Postgres is the
  authoritative store; Qdrant is the production ANN index.
- ORM/query builder: Drizzle ORM + `postgres-js`.
- Async jobs: Cloudflare Queues.
- Admission/cache: Durable Objects provide primary hot-path rate/concurrency
  control. KV provides API-key/entitlement caches and fallback controls.
- AI: OpenAI `text-embedding-3-small` embeddings and OpenAI extraction in
  production. ZeroEntropy `zerank-2` is the active production reranker; the
  Voyage adapter and migration work are present but not the active baseline.
- Observability: structured logs, custom metrics in Analytics Engine, Workers
  traces, and Grafana log/trace destinations through `@crosmos/observability`.

## Provider Boundaries

- Product and pipeline logic must depend on ports, not provider SDKs or runtime bindings.
- Cloudflare-specific APIs belong in adapters only: Wrangler config, Worker entrypoints, `apps/*/src/bindings.ts`, and integrations named for Cloudflare/KV/Queues.
- Background work should go through `@crosmos/runtime` `BackgroundTasks`; queue consumers should use `QueueDelivery`; application logs should use `@crosmos/observability`.
- Tests and future non-Cloudflare runtimes should use memory/inline adapters instead of importing Cloudflare Workers types.

## Coding Practices

- Keep code in the existing app/package boundaries. API feature code goes under `apps/api/src/features/<domain>`.
- Keep route schemas beside the route in `schemas.ts`; wire JSON stays snake_case for API compatibility.
- Use `OpenAPIHono`/`createRoute` for HTTP routes that should appear in `/openapi.json`.
- Route modules own HTTP concerns: schema registration, auth/access mapping,
  status codes, and response serialization. Services must not throw
  `HTTPException`.
- Use the shared error envelope for API errors; expected application failures
  cross the service boundary as typed results or application errors.
- Use `TenantScope` only after auth and space access have passed. Every org/space data query should scope by both `orgId` and `spaceId`.
- Keep integration ports/adapters thin (`integrations/<name>/port.ts`, concrete adapters next to it).
- Do not make ingestion/retrieval parity constants env-configurable unless the product behavior is intentionally changing.
- Shared cross-worker contracts live in `packages/types`. If the queue message shape changes, update the API producer and ingestion consumer in the same deploy.
- DB schema lives in `packages/db/src/schema`; generated SQL migrations live in `packages/db/migrations`.
- Use Bun commands. Avoid introducing npm/yarn/pnpm lockfiles.

## Runtime Constraints

- Workers are request/isolate oriented. Avoid long-lived global mutable state except safe client factories or caches that tolerate isolate reuse.
- DB access should go through `createDb(env.HYPERDRIVE.connectionString)`.
- The API worker caches a DB handle per request via the execution context; the ingestion worker creates one DB handle per queue invocation.
- Search runs inline in the API worker. A Durable Object is the primary
  per-user concurrency limiter and KV is the fail-open fallback.
- Ingestion has a low-latency service-binding RPC trigger and a durable queue
  copy. A database claim ensures only one path processes a job.
