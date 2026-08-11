# Crosmos Hono Workers Context

Use the compact files in `.codex/` as the durable project memory. Read only the relevant file for the task:

- `.codex/stack-and-practices.md` for tooling and coding conventions.
- `.codex/deployed-architecture.md` for Cloudflare Workers, bindings, domains, and deploy commands.
- `.codex/code-architecture.md` for the monorepo layout and app/package boundaries.
- `.codex/pipelines.md` for ingestion, conversation ingestion, and retrieval/search flows.
- `.codex/operations.md` for local commands, migrations, secrets, and observability.
- `.codex/current-problems.md` for known latency, durability, and cost constraints.

## Current State

- This repo is the TypeScript/Hono Cloudflare Workers implementation.
- `api.crosmos.dev` is the current customer-facing TypeScript/Hono production API deployed from this repo.
- `staginghono.crosmos.dev` is the Hono staging environment.
- The old Python repo at `../crosmos-mem` is historical/reference code only; it is not the current production API.
- Package manager is Bun. Do not introduce npm/yarn/pnpm lockfiles.
- Current product constraints and performance problems are documented in `.codex/current-problems.md`.

## Core Invariants

- Runtime is Cloudflare Workers with Hono, Drizzle, Hyperdrive, Neon Postgres, Queues, and KV.
- API wire payloads use snake_case.
- DB schema code uses camelCase fields with Drizzle `casing: 'snake_case'`.
- Auth supports JWT bearer tokens and `csk_...` API keys.
- Use `TenantScope` after auth and space access. Scope org/space data by both `orgId` and `spaceId`.
- Ingestion runs through Cloudflare Queues; search runs inline in the API worker.
- Hard-coded ingestion/retrieval constants define behavior. Do not tune them casually.

## Main Commands

```sh
bun run typecheck
bun run build
bun --filter @crosmos/api deploy:production
bun --filter @crosmos/ingestion deploy:production
```

For DB migrations, set a direct `DATABASE_URL` and use:

```sh
bun run db:generate
bun run db:migrate
```
