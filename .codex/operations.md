# Operations

## Common Commands

```sh
bun install
bun run typecheck
bun run build
```

Run one Worker locally when the needed local secrets and services exist:

```sh
bun --filter @crosmos/api dev
bun --filter @crosmos/ingestion dev
```

Wrangler dev ports:

- API: `8787`
- Ingestion: `8788`

There is no complete local dev setup checked in today. `docker-compose.yml` provides a local Postgres on port `5433`, and the Wrangler configs point local Hyperdrive to `postgresql://crosmos:crosmos@localhost:5433/crosmos`, but `.dev.vars` and end-to-end local setup are not committed.

## Database Migrations

Drizzle config: `packages/db/drizzle.config.ts`.

`DATABASE_URL` must be a direct Postgres connection string, not a Hyperdrive binding.

```sh
DATABASE_URL=... bun run db:generate
DATABASE_URL=... bun run db:migrate
```

## Production Deploy

```sh
bun run typecheck
bun --filter @crosmos/api deploy:production
bun --filter @crosmos/ingestion deploy:production
```

Deploy both workers when changing the queue payload contract in `packages/types`.

## Secrets

API Worker secrets:

- `JWT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `RESEND_API_KEY`
- `POLAR_WEBHOOK_SECRET`
- `OPENAI_API_KEY`
- `ZEROENTROPY_API_KEY`

Ingestion Worker secrets:

- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `ZEROENTROPY_API_KEY`

Use Wrangler for secret updates, scoped to the correct app and environment.

## Observability

- Cloudflare dashboard shows Workers, Queues, usage, and live events for `hono.crosmos.dev`.
- Use `wrangler tail` from the app package when logs are needed.
- Cloudflare Workers Logs are enabled in each Worker's `wrangler.toml`; application logs use structured JSON objects through `@crosmos/observability`.

## Smoke Checks

The API exposes:

- `GET /health`
- `GET /openapi.json`
- `GET /docs`

Search and ingestion smoke tests require valid auth, a memory space, and configured external AI secrets.
