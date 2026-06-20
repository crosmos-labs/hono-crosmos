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
- `POLAR_ACCESS_TOKEN`
- `POLAR_WEBHOOK_SECRET`
- `BILLING_METADATA_SECRET`
- `OPENAI_API_KEY`
- `ZEROENTROPY_API_KEY`

API Worker billing vars:

- `POLAR_ENVIRONMENT`: `sandbox` or `production`; defaults to sandbox behavior in code.
- `POLAR_PRODUCT_ID_DEVELOPER`: Polar product id for the developer plan.
- `POLAR_PRODUCT_ID_PRO`: Polar product id for the pro plan.
- `BILLING_SUCCESS_URL`: frontend URL Polar redirects to after checkout; defaults to `${APP_BASE_URL}/billing/success`.
- `BILLING_CANCEL_URL`: reserved for frontend cancel UX; currently documented for parity with the Python repo.
- `BILLING_GRACE_PERIOD_DAYS`: grace window before scheduled reconciliation downgrades stale `past_due`/`canceled` orgs; defaults to `7`.

API Worker email vars:

- `RESEND_FROM_ADDRESS`: optional sender address; defaults to `Crosmos <hello@crosmos.dev>`.
- `INVITE_ACCEPT_URL`: frontend invite-accept URL; raw invite tokens are appended as `?token=...`. Defaults to `${APP_BASE_URL}/invites/accept`.

Polar setup:

- Create a Polar Organization Access Token with checkout, customer session, and subscription update scopes. Store it as `POLAR_ACCESS_TOKEN`; never expose it to the browser.
- Configure a Polar webhook endpoint at `/webhooks/polar`. Subscribe at minimum to `subscription.created`, `subscription.active`, `subscription.updated`, `subscription.past_due`, `subscription.canceled`, `subscription.revoked`, `order.paid`, `order.refunded`, `refund.created`, `refund.updated`, and `customer.state_changed`.
- Store the webhook endpoint secret as `POLAR_WEBHOOK_SECRET`.
- Set `BILLING_METADATA_SECRET` to a high-entropy app-owned HMAC secret. This signs checkout metadata so webhooks can safely attribute a new Polar customer/subscription back to an org.

Billing flow:

- `POST /api/v1/billing/checkout` returns a Polar checkout URL and sets `organizations.plan_pending`; it does not grant the paid plan.
- Users may take minutes or hours to complete checkout. The backend must continue to show the current `plan` plus `plan_pending` until Polar sends an actionable webhook.
- `POST /webhooks/polar` is the source of truth for paid entitlement changes. It records every verified delivery in `billing_events`, deduplicates by `webhook-id`, and only marks the event processed after the org mutation succeeds.
- If webhook dispatch fails, the route stores the error on `billing_events.error` and returns `500` so Polar retries.
- `POST /api/v1/billing/portal` creates a fresh one-shot portal URL; do not cache it client-side.
- `POST /api/v1/billing/cancel` schedules cancellation at period end and sets local status to `canceled` only as a UX hint. The final downgrade still comes from webhook/reconciliation behavior.
- The API Worker has a daily scheduled billing reconciliation cron. It downgrades orgs whose status is `past_due` or `canceled` and whose `current_period_end` is older than `BILLING_GRACE_PERIOD_DAYS`.

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
