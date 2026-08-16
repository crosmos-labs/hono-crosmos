# Log Retention and Debugging

## Retention policy

Crosmos keeps operational Worker telemetry in three tiers:

| Tier | Retention | Purpose |
|---|---:|---|
| Cloudflare Workers Logs | 7 days | Interactive incident response and recent-request debugging |
| Grafana Cloud Loki/Tempo | 14 days on Free; 30 days on Pro | Hosted log/trace correlation and request waterfalls; not the long-term archive |
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

Cloudflare's own automatic invocation envelope is distinct from Crosmos's
structured application record. In the seven-day Workers Logs tier, that
platform-managed envelope can include the connecting address inside request
headers, plus coarse geography and user-agent metadata. Crosmos does not copy
those request headers into its application logger. The selected 90-day Logpush
shape was checked against a landed production fetch on 2026-08-16: its
`Event.Request` contained only `Method` and `URL`, with no header container,
raw-IP-named path, authorization/cookie/API-key path, or exception. This
short-lived Cloudflare platform field is therefore not part of the Crosmos R2
archive, but operators should still treat the seven-day tier as personal data.

Grafana was still in its time-limited trial during the 2026-08-16 rollout. The
policy assumes the documented Free-plan fallback after the trial: 14-day log
and trace retention with 50 GB/month included for each signal. If the stack is
upgraded to Pro, the default becomes 30 days. The Grafana billing/usage page is
the authority for actual bytes received; event counts below are sizing inputs,
not a substitute for that reading.

### Production volume baseline

At `2026-08-16T10:50:25Z`, an unsampled Workers Observability calculation over
the preceding 24 hours produced:

| Production service | Log rows | Span rows |
|---|---:|---:|
| `crosmos-api-production` | 18,858 | 19,861 |
| `crosmos-ingestion-production` | 3,228 | 3,218 |
| **Total** | **22,086** | **23,079** |

The log count is the sum of structured `cf-worker` rows and automatic
`cf-worker-event` invocation rows. Every group reported `sampleInterval = 1`.
A simple 30-day projection is 662,580 log rows and 692,370 spans. That uses
about 3.31% of the 20-million-event Workers Logs monthly allowance, leaving
about 19.34 million events of headroom. For Cloudflare OTLP export's separate
10-million-event included allowances, the same projection is about 6.63% for
logs and 6.92% for traces. Keep 100% production capture unless a later full-day
Grafana byte measurement or sustained traffic growth provides contrary
evidence; reducing production sampling would directly reduce diagnostic
accuracy in both persisted Cloudflare telemetry and Grafana.

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

### Manual fallback provisioning commands

These commands are retained only as the fallback for replacing the managed
destination. Do not run them for the live job: Cloudflare's automatic setup
already created the private `cloudflare-managed-9459b43b` bucket. A replacement
bucket must remain private and have no Worker binding because log delivery is
server-side and application code must not read or write it.

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
and the writer credential. While that credential was narrowed from its original
Admin Read & Write permission to Object Read & Write, the job Health view
stalled; it loaded after the original permission was restored. Landed-object
timestamps show delivery had already begun before restoration, so this does not
prove the scope change interrupted uploads. Leave this Cloudflare-managed writer
at its generated settings rather than editing it independently of its job. Use a
separate Object Read-only token for queries. The account-level job should cover
these deployed scripts; verify each from landed records before treating that as
fact:

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
permission scoped only to the live `cloudflare-managed-9459b43b` bucket. Do not
reuse or edit Logpush's managed writer credential. Export the separate reader's
S3 credentials for the current shell; never put them in a committed env file:

```sh
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_LOG_BUCKET=cloudflare-managed-9459b43b
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

The default object layout matches the observed managed-bucket prefix
`YYYYMMDD/`. If a replacement job uses a different prefix, set
`R2_LOG_OBJECT_TEMPLATE` to the observed read-only glob, retaining a `{date}`
placeholder—for example `s3://replacement-bucket/*/dt={date}/*.json.gz`.
