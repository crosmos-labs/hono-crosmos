# Operations

status: current
owner: engineering
last_verified: 2026-08-19
owns: supported validation, migration, secret, deployment, and smoke procedures
does_not_own: provider selection or infrastructure provisioning history

## Local and validation commands

Use Bun. A complete production-equivalent local environment is not checked in;
top-level Wrangler configuration is a local development default, not a deployed
development environment. `docker-compose.yml` provides Postgres on port 5433.

```sh
bun install
bun run typecheck
bun run test
bun run build
bun --filter @crosmos/api dev
bun --filter @crosmos/ingestion dev
```

API dev uses port 8787; ingestion uses 8788. Tests that require Postgres use the
test database URLs in package scripts.

## Database migrations

Schema is defined under `packages/db/src/schema`; generated migrations and the
Drizzle journal live under `packages/db/migrations`. Use a direct Postgres URL,
never a Hyperdrive binding:

```sh
DATABASE_URL=... bun run db:generate
DATABASE_URL=postgresql://crosmos:crosmos@localhost:5433/crosmos \
  bun run db:migrate:local
```

The guarded migration command is local-only. Production changes require a
reviewed numbered SQL file applied explicitly through `psql`, followed by schema
and application verification. Generated SQL, journal, and snapshot move together.

## Production deployment

There is no supported staging deployment today. Validate all workers, then use
explicit production scripts; bare `deploy` is not an approved production command.

```sh
bun run typecheck
bun run test
bun run build
bun --filter @crosmos/api deploy:production
bun --filter @crosmos/ingestion deploy:production
bun --filter @crosmos/admin deploy:production
```

Deploy API and ingestion together for an ingestion contract change. Structural
sanitation must not be used to switch an AI provider or ranking configuration.

## Secrets

| Worker | Secrets by enabled production path |
|---|---|
| API | `JWT_SECRET`, Google OAuth secrets, `RESEND_API_KEY`, `POLAR_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `ZEROENTROPY_API_KEY`, Qdrant and billing/OAuth secrets used by bindings |
| Ingestion | `OPENAI_API_KEY`, `QDRANT_API_KEY` |
| Admin | Cloudflare Access team/audience and `ADMIN_ALLOWED_EMAILS` configuration |

Adapter-specific secrets such as `VOYAGE_API_KEY` or `OPENROUTER_API_KEY` are
needed only when that adapter is explicitly enabled. Set secrets with Wrangler
for the production environment; never commit `.dev.vars` or benchmark secrets.

## Observability and smoke checks

Workers Logs/traces and Analytics Engine are enabled for all three production
workers, with Grafana destinations configured for API and ingestion. Use each
package's `tail`/Wrangler tooling and the queries in `docs/metrics-runbook.md`.

Read-only API checks:

- `GET https://api.crosmos.dev/health`
- `GET https://api.crosmos.dev/openapi.json`
- authenticated `GET /api/v1/spaces`
- authenticated search against a known space

Never deploy merely to perform a maintainability verification.
