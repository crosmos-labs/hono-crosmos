# Crosmos Hono Workers Context

status: current
owner: engineering
last_verified: 2026-08-19
owns: repository working context and non-negotiable invariants
does_not_own: detailed component design or deployment values

Read [README.md](./README.md) first for the documentation authority order. Use
only the compact file relevant to the task:

- `.codex/stack-and-practices.md` for tooling and coding conventions.
- `.codex/deployed-architecture.md` for Cloudflare Workers, bindings, domains, and deploy commands.
- `.codex/code-architecture.md` for the monorepo layout and app/package boundaries.
- `.codex/pipelines.md` for ingestion, conversation ingestion, and retrieval/search flows.
- `.codex/operations.md` for local commands, migrations, secrets, and observability.
- `.codex/current-problems.md` for known latency, durability, and cost constraints.

## Current State

- This repo is the TypeScript/Hono Cloudflare Workers implementation.
- `api.crosmos.dev` is the current customer-facing TypeScript/Hono production API deployed from this repo.
- Production is the only supported deployed environment today. Top-level
  Wrangler configuration is for local development; checked-in staging blocks
  are not evidence that a functioning staging system exists.
- The old Python repo at `../crosmos-mem` is historical/reference code only; it is not the current production API.
- Package manager is Bun. Do not introduce npm/yarn/pnpm lockfiles.
- Current product constraints and performance problems are documented in `.codex/current-problems.md`.

## Core Invariants

- Runtime is Cloudflare Workers with Hono, Drizzle, Hyperdrive, Neon Postgres,
  Qdrant, Queues, Durable Objects, KV, and Analytics Engine.
- API wire payloads use snake_case.
- DB schema code uses camelCase fields with Drizzle `casing: 'snake_case'`.
- Auth supports JWT bearer tokens and `csk_...` API keys.
- Use `TenantScope` after auth and space access. Scope org/space data by both `orgId` and `spaceId`.
- Ingestion is triggered by service-binding RPC and backed by Cloudflare
  Queues; both paths share a database claim. Search runs inline in the API
  worker.
- Hard-coded ingestion/retrieval constants define behavior. Do not tune them casually.

## Main Commands

```sh
bun run typecheck
bun run test
bun run build
bun --filter @crosmos/api deploy:production
bun --filter @crosmos/ingestion deploy:production
bun --filter @crosmos/admin deploy:production
```

For DB migrations, set a direct `DATABASE_URL` and use:

```sh
bun run db:generate
bun run db:migrate
```
