# Log Retention and Debugging

## Retention policy

Crosmos keeps operational Worker logs in two tiers:

| Tier | Retention | Purpose |
|---|---:|---|
| Cloudflare Workers Logs | 7 days | Interactive incident response and recent-request debugging |
| Dedicated R2 archive | 90 days | Post-incident review, regression investigation, and quarterly operational comparisons |

The R2 period is enforced by a bucket lifecycle rule, not by a manual deletion
process. The archive is operational telemetry: structured event names,
pseudonymous internal identifiers, bounded status/category values, counts, and
durations. User source content, memory text, search queries, names, email
addresses, credentials, and raw authorization headers are forbidden by the
`@crosmos/observability` field allowlist.

The purpose of retention is service security, reliability, debugging, and
performance verification. Ninety days is long enough to investigate a delayed
customer report or a quarter-long regression and short enough to avoid keeping
operational identifiers indefinitely. Access is restricted to operators with a
debugging need. Archived objects are not a product analytics or customer audit
API.

Rate-limit events persist only a 16-hex-character HMAC prefix in `ip_hash`.
The raw address is used ephemerally as the Durable Object limiter key and is
never admitted by the log allowlist. If `LOG_IP_HASH_SALT` is missing, the log
omits the hash rather than falling back to the raw address.

Rotate `LOG_IP_HASH_SALT` monthly and after any suspected disclosure. Rotation
intentionally breaks correlation between months without resetting live
rate-limit buckets. Generate and upload it without placing the value in shell
history:

```sh
openssl rand -hex 32 | bunx wrangler secret put LOG_IP_HASH_SALT --env staging
openssl rand -hex 32 | bunx wrangler secret put LOG_IP_HASH_SALT --env production
```

Deploy and inspect staging first. Production Logpush must not be enabled until
the production Worker version containing this change and the secret are live;
discard any archive objects accidentally created before then.

## Deleted-space retention

Crosmos retains a deleted memory space for **30 days** before it becomes
eligible for physical deletion. The space is inaccessible through normal APIs
immediately after deletion, but an authorized operator can restore it during
that window. Thirty days gives a practical accidental-deletion recovery period
while placing a finite bound on retained customer data for erasure requests and
security questionnaires.

After 30 days, the finalizer deletes the Postgres records and external vectors.
That deletion is irreversible. `SPACE_FINALIZER_ENABLED` is a separate
environment kill switch and remains off until the migration, restore flow, and
staging observations are complete; disabling it lengthens retention but never
shortens the documented recovery window. The admin tombstone view reports each
space's deletion time and purge-eligibility time, and every restore is written
to `admin_audit_log`.

## Debugging: choose the right tier

- **Happening now:** use `wrangler tail`. It is live-only and is appropriate for
  watching a request you are about to make.
- **From the last 7 days:** query Workers Logs. Start with `request_id` or
  `correlation_id`; do not reproduce the incident just to make it appear in a
  live stream.
- **From 8 to 90 days ago:** use `scripts/query-logs.ts` against the R2 archive
  after L-3/L-4 are enabled.

Workers Logs are queried through Cloudflare's persisted Observability API. Set
`CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` scoped to Workers
Observability, then run:

```sh
# One API request from yesterday, across every Worker.
bun scripts/query-workers-logs.ts \
  --request-id 00000000-0000-0000-0000-000000000000 \
  --since 24h

# One ingestion chain, including continuations.
bun scripts/query-workers-logs.ts \
  --correlation-id 00000000-0000-0000-0000-000000000000 \
  --since 7d

# Recent instances of one structured event in the production API Worker.
bun scripts/query-workers-logs.ts \
  --event api.dependency_unavailable \
  --script crosmos-api-production \
  --since 7d
```

The script performs full-text matching because the structured application
record is stored inside Cloudflare's log message. Use `--script` only when the
request is known to stay in one Worker; omit it for cross-worker correlation.
The command prints the API's event objects as JSON so no Cloudflare fields are
silently discarded.

The equivalent dashboard workflow is Workers & Pages → the Worker →
Observability → Query Builder, select the time range, then search for the
identifier. The account-wide Query Builder is preferable when a correlation ID
crosses the API and ingestion Workers.

## Archive configuration record

External state is recorded here before L-3 is marked complete:

| Setting | Required value | Deployed value |
|---|---|---|
| Dataset | `workers_trace_events` | Account job `1838803`, enabled and reporting `Pushing` on 2026-08-14 |
| Workers | API and ingestion, production and staging | `crosmos-api-production` verified from a landed record; ingestion and staging coverage pending |
| Destination | Dedicated private R2 bucket, date-partitioned gzipped NDJSON | Cloudflare-managed private bucket `cloudflare-managed-9459b43b` in APAC; objects verified under `20260814/`. The original empty `crosmos-worker-logs` bucket is retained until verification finishes. |
| Selected fields | `Event`, `EventTimestampMs`, `Outcome`, `Exceptions`, `Logs`, `ScriptName` | All required fields verified in a landed API record; automatic setup also includes runtime timing, entrypoint, tags, and version fields |
| Sampling | 100% production; staging reviewed after L-1 volume measurement | Automatic job default is unsampled; live output verification pending |
| Lifecycle | Delete objects after 90 days | Enabled rule `expire-operational-logs` on the managed destination, verified 2026-08-14 |
| Query credential | Read-only, bucket-scoped R2 token | _pending_ |

`logpush = true` is committed for the default, staging, and production variants
of both Workers. It takes effect on their next deployment. The account job uses
the Workers Trace Events dataset and filters by script if Cloudflare's account
configuration cannot select the intended Workers directly.
The `Logs` and `Exceptions` fields have a combined 16,384-character per-
invocation limit; a maximum-size ingestion run must be checked for Cloudflare's
truncation marker before this archive is treated as complete.

Never put Cloudflare, R2, database, API, or Crosmos user credentials in this
file, shell history, captured output, or a committed `.env` file.

### Account provisioning commands

Run these from a network-enabled operator shell authenticated to the intended
Cloudflare account. The bucket is private and has no Worker binding because log
delivery is server-side and application code must not read or write it.

```sh
export WRANGLER_LOG_PATH=/tmp/crosmos-wrangler.log
bunx wrangler r2 bucket create crosmos-worker-logs --location enam
bunx wrangler r2 bucket lifecycle add \
  crosmos-worker-logs expire-operational-logs '' \
  --expire-days 90 --force
bunx wrangler r2 bucket lifecycle list crosmos-worker-logs
```

Cloudflare's automatic R2 setup was used after the manual destination form
stalled in the dashboard. It created account job `1838803`, its destination,
and the writer credential. Narrowing that generated credential from its original
Admin Read & Write permission to Object Read & Write caused the job Health view
to stall and produced no uploads; restoring the generated permission restored
delivery. Do not edit this Cloudflare-managed writer independently of its job.
Use a separate Object Read-only token for queries. The account-level job should
cover these deployed scripts; verify each from landed records before treating
that as fact:

- `crosmos-api-production`
- `crosmos-api-staging`
- `crosmos-ingestion-production`
- `crosmos-ingestion-staging`

If the account job does not retain `ScriptName` or cover every intended script,
replace it with separate date-partitioned jobs using this destination shape:

```text
r2://crosmos-worker-logs/<SCRIPT_NAME>/{DATE}?account-id=<ACCOUNT_ID>&access-key-id=<R2_WRITE_ACCESS_KEY_ID>&secret-access-key=<R2_WRITE_SECRET_ACCESS_KEY>
```

Do not paste a populated destination URL into this file or command history.
After creation, replace the `_pending_` cells above with non-secret job IDs,
script filters, bucket/prefixes, lifecycle rule ID, deployment versions, and
verification timestamps.

## Querying the R2 archive

Install the DuckDB CLI and create a separate R2 API token with Object Read
permission scoped only to `crosmos-worker-logs`. Export its S3 credentials for
the current shell; never put them in a committed env file:

```sh
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_LOG_BUCKET=crosmos-worker-logs
```

`scripts/query-logs.ts` sends the temporary DuckDB secret over stdin, so the
credential is not present in the process argument list. It scans only the UTC
date partitions in the requested range and requires at least one filter.

```sh
# Trace one request across both Workers.
bun scripts/query-logs.ts \
  --from 2026-07-20 --to 2026-07-21 \
  --request-id 00000000-0000-0000-0000-000000000000

# Reconstruct an ingestion job, including queue continuations.
bun scripts/query-logs.ts \
  --from 2026-07-01 --to 2026-07-31 \
  --correlation-id 00000000-0000-0000-0000-000000000000

# Count database-capacity errors over a month.
bun scripts/query-logs.ts \
  --from 2026-07-01 --to 2026-07-31 \
  --event api.dependency_unavailable --level error --count
```

The default object layout assumes Logpush expands `{DATE}` as `YYYYMMDD`. If
the first landed object uses a different prefix, set
`R2_LOG_OBJECT_TEMPLATE` to the observed read-only glob, retaining a `{date}`
placeholder—for example `s3://crosmos-worker-logs/*/dt={date}/*.json.gz`.
