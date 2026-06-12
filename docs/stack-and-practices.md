# Stack And Practices

## Stack

- Package manager: Bun (`packageManager`: `bun@1.3.5`).
- Monorepo/task runner: Bun workspaces + Turborepo.
- Runtime: Cloudflare Workers with `nodejs_compat`.
- HTTP framework: Hono + `@hono/zod-openapi`.
- Database: Neon Postgres with pgvector, reached from Workers through Cloudflare Hyperdrive.
- ORM/query builder: Drizzle ORM + `postgres-js`.
- Async jobs: Cloudflare Queues.
- Cache/counters: Cloudflare KV (`API_KEY_CACHE`, also used for rate-limit/concurrency counters).
- AI: OpenAI embeddings (`text-embedding-3-small`), OpenRouter/OpenAI-compatible extraction LLM, ZeroEntropy reranker.
- Observability: structured JSON `console.*` logs captured by Cloudflare Workers Logs through `@crosmos/observability`.

## Provider Boundaries

- Product and pipeline logic must depend on ports, not provider SDKs or runtime bindings.
- Cloudflare-specific APIs belong in adapters only: Wrangler config, Worker entrypoints, `apps/*/src/bindings.ts`, and integrations named for Cloudflare/KV/Queues.
- Background work should go through `@crosmos/runtime` `BackgroundTasks`; queue consumers should use `QueueDelivery`; application logs should use `@crosmos/observability`.
- Tests and future non-Cloudflare runtimes should use memory/inline adapters instead of importing Cloudflare Workers types.

## Coding Practices

- Keep code in the existing app/package boundaries. API feature code goes under `apps/api/src/features/<domain>`.
- Keep route schemas beside the route in `schemas.ts`; wire JSON stays snake_case for API compatibility.
- Use `OpenAPIHono`/`createRoute` for HTTP routes that should appear in `/openapi.json`.
- Use `HTTPException` for expected route errors and return `{ detail: ... }` bodies.
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
- Search runs inline in the API worker and uses KV for per-user concurrency control.
- Ingestion runs asynchronously through Cloudflare Queues; one queue message represents one ingestion job.
