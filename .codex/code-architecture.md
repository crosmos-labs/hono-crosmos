# Code Architecture

status: current
owner: engineering
last_verified: 2026-08-19
owns: application/package boundaries and mounted HTTP surface
does_not_own: endpoint payload details, deployment resource values, or roadmap

## Monorepo map

```text
apps/
  api/           Public Hono API, scheduled maintenance, RateLimiterDO
  ingestion/     Queue + service-binding ingestion Worker
  admin/         Access-gated operational Hono API, AdminRateLimiterDO
packages/
  db/            Drizzle schema, database factory, repositories/helpers
  types/         Cross-worker contracts and TenantScope
  ai/            Embedding and reranker ports/adapters
  vector/        Vector-store ports, Qdrant and Vectorize adapters
  runtime/       Worker-neutral deadlines, background work, caches, entitlements
  observability/ Structured logging, metrics, tracing helpers
  test-support/  Shared integration-test database and fixtures
```

Dependencies flow from apps into packages. Shared packages must not import app
code. Provider selection belongs at Worker composition roots; domain services
depend on ports. `@crosmos/db` leaf modules import database types from a leaf
module, never back through the package barrel.

## API Worker

`apps/api/src/index.ts` is the composition root. It owns global middleware,
error mapping, OpenAPI/docs, scheduled maintenance, Worker exports, and these
mounted route groups:

| Prefix | Feature ownership |
|---|---|
| `/api/v1/auth`, `/api/v1/auth/oauth` | Sessions, API keys, Google OAuth consumer |
| `/api/v1/orgs` | Organizations, members, invites, entitlements, visibility policy |
| `/api/v1/spaces` | Spaces, space usage, space analytics |
| `/api/v1/sources` | Source lifecycle and ingestion dispatch |
| `/api/v1/conversations` | Conversation source ingestion |
| `/api/v1/memories` | Memory reads and forgetting |
| `/api/v1/entities`, `/api/v1/graph` | Knowledge-graph reads |
| `/api/v1/search` | Admission and inline retrieval |
| `/api/v1/jobs` | Ingestion job status |
| `/api/v1/usage`, `/api/v1/analytics` | Customer metering and analytics |
| `/api/v1/billing`, `/webhooks` | Plans, checkout/subscription operations, Polar webhooks |
| `/oauth/*`, `/.well-known/*` | OAuth server metadata/flows and security metadata |
| `/health`, `/openapi.json`, `/docs` | Operations and API description |

Feature directories contain schemas, HTTP route adapters, and application/domain
services. Route modules translate HTTP to typed service calls; service modules
must not own Hono response objects or HTTP exceptions. Integrations implement
provider/runtime ports. `lib` is reserved for genuinely cross-feature API
infrastructure.

## Ingestion Worker

`apps/ingestion/src/index.ts` is the composition root for queue, dead-letter,
and service-binding RPC delivery. `process-ingestion.ts` coordinates a job;
`ingestion/pipeline.ts` coordinates one source. Extractors own memory/graph
interpretation, integration modules own providers and storage, and the ontology
and prompt directories contain extraction policy.

Queue and RPC delivery must converge on the same atomic database claim. Queue
messages are cross-worker contracts from `@crosmos/types`; continuation messages
represent healthy checkpoint progress and do not consume the failure policy.

## Admin Worker

`apps/admin/src/index.ts` is the composition root. Authentication requires a
valid Cloudflare Access JWT and an exact external email allowlist match. The
worker provides bounded, content-safe operational reads and audited mutations.
Authentication, rate limiting, request plumbing, route groups, and persistence
helpers belong in separate modules as the worker grows.

## Data ownership

Postgres is authoritative for identities/auth, organizations/memberships,
spaces, sources, chunks, memories, `chunk_memories`, entities/edges,
visibility groups/grants, ingestion jobs, entitlements/billing, usage rollups,
and admin audit records. Qdrant stores rebuildable memory/entity vectors only.
TypeScript uses camelCase Drizzle fields with `casing: 'snake_case'` for SQL.
