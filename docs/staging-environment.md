# Staging environment (`staginghono.crosmos.dev`) + prod DB cutover

A Wrangler **named environment** `staging` on both Workers, mirroring `production`
(same providers + same secret *values*) but with **fully isolated data**.

- **API** → `https://staginghono.crosmos.dev` (custom domain; created on first deploy)
- **Ingestion** → `crosmos-ingestion-staging` (no public route; service-binding RPC + queue only)
- **Access gate**: none at the edge — every route still requires a valid API
  key / OAuth token, same as prod. (To make it unreachable without login later,
  layer Cloudflare Access on the `staginghono.crosmos.dev` route — no code change.)

## Isolation map

| Resource        | Production                              | Staging                                  | Status |
|-----------------|-----------------------------------------|------------------------------------------|--------|
| Neon DB         | `crosmos-neon-prod-v2` → `ep-blue-block` (HD `53d75344f62e4e4da0974c2fdfcc5b0d`) | `crosmos-neon-staging` → `ep-curly-mouse` (HD `930052d5e0dc40c8911417c7ef3e8c13`) | ✅ created + migrated |
| Qdrant          | `crosmos-memories` / `crosmos-entities` on `413d870d…` cluster | `crosmos-memories-staging` / `crosmos-entities-staging` on **separate** `52fd164c…` cluster | ✅ created |
| KV `API_KEY_CACHE` | `25fed42f…`                          | `0af915afd8064727b0290dbc2db10d0c`       | ✅ done |
| Queue           | `ingestion-jobs` (+`-dlq`)              | `ingestion-jobs-staging` (+`-dlq`)       | ✅ done |
| Service binding | `crosmos-ingestion-production`          | `crosmos-ingestion-staging`              | ✅ in config |
| Placement       | targeted `aws:us-east-1`                | targeted `aws:us-east-1`                 | ✅ in config |
| Vectorize/AI    | dormant (`*-v3` / AI)                   | dormant (bound to `*-dev` indexes)       | ✅ in config |

## Prod DB cutover (done 2026-06-23 — fresh start)

Prod was repointed to a **new empty Neon DB** and its Qdrant was **wiped** for a
clean slate. Executed:
1. `wrangler hyperdrive create crosmos-neon-prod-v2` → `53d75344f62e4e4da0974c2fdfcc5b0d`
   (non-pooler `ep-blue-block` conn string; Hyperdrive does its own pooling).
2. `bun run db:migrate` against the new DB (direct conn) — all 5 migrations applied.
3. Hyperdrive id swapped in `apps/{api,ingestion}/wrangler.toml` `[env.production]`.
   **Rollback ids preserved in comments**: `72fcf1cc…` (prior Neon us-east-1),
   `18f010ae…` (Supabase us-east-2).
4. Wiped prod Qdrant: deleted + recreated `crosmos-memories` (was 320 pts) and
   `crosmos-entities` (was 270 pts), 1536/cosine, now 0/0. **Irreversible.**
5. `wrangler deploy --env production` for ingestion then api. Verified:
   `/health` → 200 `production`; bogus-bearer key lookup → `401` (DB reachable).

To roll back the DB (Qdrant data is gone regardless): restore the old Hyperdrive
id in both `[env.production.hyperdrive]` blocks and redeploy.

## Staging — remaining setup (your action)

### 1. Secrets — same VALUES as prod, set per-env
Wrangler secrets are write-only, so prod's values can't be copied automatically.
`QDRANT_API_KEY` (staging cluster) is **already set**. Run the rest with
`npx wrangler secret put <NAME> --env staging`:

- **`apps/api`**: `BILLING_METADATA_SECRET`, `BILLING_SUCCESS_URL`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INVITE_ACCEPT_URL`, `JWT_SECRET`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `POLAR_ACCESS_TOKEN`,
  `POLAR_PRODUCT_ID_DEVELOPER`, `POLAR_PRODUCT_ID_PRO`, `POLAR_WEBHOOK_SECRET`,
  `RESEND_API_KEY`, `SENTRY_DSN`, `ZEROENTROPY_API_KEY`
- **`apps/ingestion`**: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `SENTRY_DSN`,
  `ZEROENTROPY_API_KEY`

> Consider staging-specific values for `BILLING_SUCCESS_URL` / `INVITE_ACCEPT_URL`
> and registering `https://staginghono.crosmos.dev/...` redirect/webhook URLs in
> the Google OAuth + Polar dashboards if you exercise those flows. Otherwise reuse
> prod values.

### 2. Deploy (ingestion first — the API service-binds to it)
```sh
cd apps/ingestion && npx wrangler deploy --env staging
cd ../api        && npx wrangler deploy --env staging   # creates the staginghono.crosmos.dev DNS/custom-domain route
```

### 3. Smoke test
```sh
curl -s https://staginghono.crosmos.dev/health           # -> {"status":"ok","environment":"staging",...}
curl -s -o /dev/null -w "%{http_code}\n" https://staginghono.crosmos.dev/api/v1/orgs   # -> 401 (auth wall)
```

## Later: promote hono → `api.crosmos.dev`

Change `[[env.production.routes]]` pattern in `apps/api/wrangler.toml` from
`hono.crosmos.dev` to `api.crosmos.dev` (and `OAUTH_SERVER_BASE_URL` /
`APP_BASE_URL` to `https://api.crosmos.dev`), remove the old `api.crosmos.dev`
route from whatever serves it today, then redeploy. Tracked separately.
