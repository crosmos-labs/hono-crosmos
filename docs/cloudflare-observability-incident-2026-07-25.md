# Cloudflare Workers incident analysis — 25 July 2026

Status: read-only analysis; no deployment, configuration, application data, or runtime state was changed.

## Executive summary

The error spike was not one failure. It was a cascade centered on
`POST /api/v1/search`:

1. A single identifiable client signature sent sustained search traffic and
   automatically retried most failed calls once.
2. The account's Postgres provider began rejecting work because its usage
   allowance was exhausted until `2026-07-26 00:00:00 UTC`.
3. A second large class of search invocations was terminated by Cloudflare for
   exceeding the effective Worker CPU allowance.
4. In-flight searches accumulated. The per-user concurrency guard then rejected
   most new calls with HTTP 429.
5. Immediate SDK retries nearly doubled the pressure while very rarely
   recovering.

In the exact 4.5-hour incident window, historical Cloudflare telemetry contains
20,304 public `/api/v1/search` invocations:

| Result | Count | Share |
|---|---:|---:|
| HTTP 429, concurrency guard | 10,757 | 52.98% |
| HTTP 500 | 4,529 | 22.31% |
| Cloudflare CPU termination | 2,919 | 14.38% |
| HTTP 200 | 2,098 | 10.33% |
| Other successful invocation without a response status | 1 | <0.01% |

This means 89.7% of observed search invocations in that window did not return
HTTP 200. The dashboard screenshot is an **event** chart, not a clean count of
public requests: it also includes structured application logs, internal Durable
Object calls, and sometimes multiple platform rows for one failed invocation.
Its 676,693 “Success” and 27,069 “Errors” must therefore not be read as an HTTP
success rate.

The two reported Crosmos recall timeouts are consistent with a three-second
client deadline, not a server-side 504. Successful search p95 was 2.865 seconds
and p99 was 4.388 seconds. No server-side search 504 was observed. The fail-open
behavior is therefore credible: the client can abandon recall at three seconds
while the Worker finishes successfully and the reply/event flow continues.
However, the exact reported event cannot be proven to have completed triage or
entered an outbox because those lifecycle events are not logged by this backend
and the accepted-ingestion log omits the job and correlation IDs.

## Scope and evidence

### Time windows

- Main incident window: `2026-07-25T16:00:00Z` to
  `2026-07-25T20:30:00Z` (21:30 to 02:00 IST).
- The sustained flood starts near 17:00 UTC and stops near 20:16 UTC.
- Post-incident check: `2026-07-25T20:30:00Z` to
  `2026-07-25T21:49:19.708Z`.
- Broader review: the preceding 72 hours.

### Sources

- Cloudflare Workers Observability MCP historical telemetry for
  `crosmos-api-production` and `crosmos-ingestion-production`.
- The exported JSON file
  `logs-2026-07-25T21_49_19.708Z.json`.
- Source tree at commit `776bdec` on branch `payment-history`.
- Cloudflare's official [Workers platform limits documentation](https://developers.cloudflare.com/workers/platform/limits/)
  and [Wrangler `limits` configuration documentation](https://developers.cloudflare.com/workers/wrangler/configuration/#limits).

The downloaded file contains exactly 2,000 rows and is 4.1 MB, but covers only
`2026-07-25T21:31:49.936Z` through `2026-07-25T21:48:00.343Z`. It is useful for
checking recovery and the client's request headers, but it does not contain the
earlier incident. Historical MCP telemetry supplies that missing interval.

### Counting caveat

Cloudflare's broad, long-range aggregations are sampled/extrapolated and can
return totals that differ from a narrow query over the same population. For
example, a single 72-hour aggregation estimated far more `/search` 429s than
the hour-by-hour partitions. Accordingly:

- The headline 20,304 count comes from the narrow incident query reconciled
  against hourly partitions.
- Low-cardinality 72-hour findings are reported as observed log/event counts.
- Dashboard “Events” totals are not treated as public-request counts.
- Repeated platform/application rows are explicitly distinguished from unique
  invocations where possible.

## Incident timeline

| UTC interval | What the telemetry shows |
|---|---|
| 16:00–17:00 | Normal: 12 successful search calls. |
| 17:00–18:00 | Load begins. 3,869 concurrency 429s, 510 CPU terminations, and 3 HTTP 500s; only 816 HTTP 200s. |
| 18:00–19:00 | 4,954 concurrency 429s and 625 CPU terminations; 812 HTTP 200s. |
| 19:00–20:00 | Provider-budget 500s dominate alongside CPU terminations; 458 HTTP 200s. |
| 20:00–20:16 | 1,408 HTTP 500s and 528 CPU terminations; traffic then stops. |
| 20:30–21:49 | Recovery: 55 `/search` calls, all HTTP 200; worker wall-time p95 2.273 seconds. |
| 21:31–21:48 export | 34 successful `/search` invocations; max worker wall time 2.595 seconds, max CPU 84 ms, no application errors. |

## Failure classes and root causes

### 1. Per-user concurrency rejection — 10,757 HTTP 429s

Every structured `retrieval.request_rejected` warning in the incident was at
stage `concurrency_acquire`. Exact-filter checks found no incident rejections
from:

- plan rate limit;
- monthly quota;
- global AI throttle; or
- space access.

This is therefore not evidence of a plan quota, global Workers AI quota, or
random edge abuse. It is the application's per-user concurrent-search guard.
The default cap is 10.

The guard is reached relatively late:

```text
authentication
  -> management rate limiter
  -> entitlements + space access
  -> plan AI rate limiter
  -> monthly quota
  -> per-user concurrency acquire
  -> global AI limiter
  -> embedding + retrieval + reranking
```

A concurrency-rejected call had already performed several reads and limiter
subrequests. Despite doing no retrieval, 429 invocations averaged 7.17 ms of
Worker CPU and 128 ms wall time; p95 wall time was 154 ms.

The route schedules the release in `finally`, which is correct for ordinary
exceptions. A Cloudflare CPU termination can kill the isolate before the
`finally`/`waitUntil` release completes. The Durable Object's expiry eventually
self-heals leaked slots, but retries keep the user's counter at capacity in the
meantime.

Relevant code:

- `apps/api/src/features/search/routes.ts:286` — concurrency is acquired after
  the earlier gates.
- `apps/api/src/features/search/routes.ts:302` — rejected acquire becomes 429.
- `apps/api/src/features/search/routes.ts:504` — release is scheduled in
  `finally`.
- `apps/api/src/features/search/concurrency.ts:109` — Durable Object-backed
  limiter.
- `apps/api/src/features/search/constants.ts:115` — default cap of 10.

### 2. Automatic retry amplification — 9,178 extra invocations

The traffic had one consistent SDK signature, `Crosmos/JS 0.1.0`, and one
network organization/country signature. No IP address is included in this
report.

| SDK attempt | Invocations | Share of traffic |
|---|---:|---:|
| Initial (`x-stainless-retry-count: 0`) | 11,126 | 54.80% |
| Automatic retry (`x-stainless-retry-count: 1`) | 9,178 | 45.20% |

The retry attempts produced only 466 HTTP 200s: a 5.08% recovery rate. About
94.9% of retry work failed again. Relative to initial traffic, retries added
82.5% more invocations.

Immediate retries are especially harmful here:

- A concurrency 429 says the user's existing work has not drained; retrying
  immediately makes that condition worse.
- A provider account-budget failure is deterministic until renewal and cannot
  be repaired by a per-request retry.
- A CPU-limit termination is likely to recur for the same payload and code path.

The client should not automatically retry these classes in the synchronous
recall path. If 429 retries are retained elsewhere, they should honor
`Retry-After`, apply jitter, use a strict attempt budget, and be cancellable.

### 3. Postgres/Neon account usage exhaustion — primary HTTP 500 cause

The dominant application error was:

> Usage limit for account exceeded, usage renews at 2026-07-26 00:00:00 UTC

There were 4,616 incident log rows with this provider message and 4,685 in the
72-hour review. The incident also contains 4,577 `api.unhandled_error` events.
The close match, timestamps, and HTTP 500 population identify provider-budget
exhaustion as the dominant 500 path.

These errors reach the top-level API error handler instead of a
dependency-specific catch. Consequently:

- callers receive a generic 500;
- SDK retry policy cannot distinguish a deterministic provider outage;
- the system continues performing admission work for calls that cannot succeed;
- alerting sees “unhandled” failures rather than a precise database-budget
  signal.

This was not caused by the monthly Crosmos search quota; that gate had zero
rejections in the incident.

### 4. Cloudflare CPU-limit terminations — 2,919 invocations

Cloudflare terminated 2,919 search invocations for exceeding CPU time. Of these,
2,897 returned/recorded 503 and 22 died without a response status.

CPU-terminated searches had:

- average CPU: 12.5 ms;
- p95 CPU: 23 ms;
- p99 CPU: 36 ms.

Successful searches reached much higher values:

- p95 CPU: 70 ms;
- p99 CPU: 110 ms;
- maximum CPU: 148 ms.

There is no `limits.cpu_ms` setting in the checked-in production Wrangler
configuration. Cloudflare documents a 10 ms Free-plan CPU limit and a 30-second
default on paid Workers, with configurable paid limits. The termination
distribution beginning around the low tens of milliseconds strongly suggests
an effective Free-plan/very-low CPU limit, but the account plan and dashboard
setting were not exposed by the connected tool. This is a strong inference, not
a confirmed account fact.

First verify the production Worker's effective plan and CPU limit in the
Cloudflare dashboard. If it is 10 ms, the search workload—fusion, JSON handling,
logging, response construction, and reranking orchestration—is not compatible
with that budget. Raising the CPU allowance is a necessary mitigation, but it
should be paired with profiling rather than setting an arbitrarily large limit.

### 5. Pathological full-text search input

Five distinct structured retrieval failures (ten repeated error log rows)
reported Postgres `tsquery stack too small`. The keyword signal passes the
complete user query to `websearch_to_tsquery`:

- `apps/api/src/features/search/signals/keyword.ts:25`

The graph entity seed also OR-joins all supplied tokens before calling
`websearch_to_tsquery`:

- `apps/api/src/features/search/candidates.ts:78`

`websearch_to_tsquery` avoids ordinary syntax errors, but a sufficiently complex
or long input can still create an oversized tsquery expression. Bound the
number and size of search lexemes, collapse repeated tokens, and make the
keyword signal fail soft to an empty signal or simpler query so one auxiliary
signal cannot fail the entire hybrid retrieval.

### 6. Smaller transient dependencies

The 72-hour API review also found:

- 60 `Network connection lost` rows, largely Hyperdrive/Postgres connectivity;
- four connection-closed errors involving `hyperdrive.local:5432`;
- nine structured embedding failure events involving OpenAI, with repeated raw
  log rows;
- two Qdrant 502 log rows;
- four `daily_usage_space_id_memory_spaces_id_fk` write-side failures;
- five invalid-token warnings.

These are operationally relevant but too small to explain the dashboard spike.
The daily-usage foreign-key error occurs in best-effort search bookkeeping and
should not turn a successful retrieval into a failed response.

## Requests, subrequests, and avoidable work

### Internal Durable Object traffic

During the 20,304 public search invocations, telemetry observed at least:

| Internal call | Event count |
|---|---:|
| `POST https://ratelimit/limit` | 60,349 |
| `POST https://concurrency/acquire` | 14,112 |
| `POST https://concurrency/release` | 2,106 |
| **Minimum identified internal calls** | **76,567** |

This is at least 3.77 internal Durable Object fetches per public search
invocation, excluding database, vector, embedding, reranking, KV, and other
service calls. There were also 29 calls to a legacy/alternate
`https://rate-limiter/limit` endpoint.

The roughly three `ratelimit/limit` calls per search are consistent with the
management auth limit, plan AI limit, and global AI throttle. Rejected requests
therefore generated substantial internal traffic before failing.

This is not evidence that a per-invocation Cloudflare subrequest ceiling was
hit. It is a cost, latency, and amplification problem. Cloudflare's current
[limits documentation](https://developers.cloudflare.com/workers/platform/limits/)
should be used to confirm the plan's exact external and internal subrequest
allowances.

### Admission-path optimization

Keep authentication first, but shed duplicate/overloaded recall work as early
and cheaply as possible:

1. Add client-side singleflight/debouncing per session or query. Permit only one
   current recall and cancel stale searches.
2. Add an early coarse per-principal overload gate immediately after identity is
   known and before database-backed entitlement/quota work.
3. Consider combining compatible admission checks in one Durable Object
   round-trip or skipping redundant management-limit work when the stricter AI
   path gate is authoritative.
4. Make concurrency acquisition idempotent by invocation/correlation ID.
   Retrying the same logical search must not consume another lease.
5. Use tokenized, expiring leases with release-by-token. This makes recovery
   from CPU-killed Workers deterministic and avoids one request decrementing
   another request's slot.

The exact reordering must preserve authorization and tenant isolation. A cheap
coarse overload gate can move earlier; space access and authoritative quota
enforcement must not be removed.

## Search latency and the Crosmos recall report

### Observed successful latency

For HTTP 200 search access events:

| Metric | Value |
|---|---:|
| Mean | 1.021 s |
| p95 | 2.865 s |
| p99 | 4.388 s |
| Maximum | 10.398 s |
| Responses at or above 3 s | 110 |

Structured `retrieval.request_completed` duration was:

| Metric | Value |
|---|---:|
| Mean | 0.808 s |
| p95 | 2.402 s |
| p99 | 2.906 s |
| Maximum | 10.302 s |

The difference reflects time outside the route's retrieval timer, including
middleware/admission and response handling.

The JSON export contains `x-stainless-timeout: 3`. A three-second client
deadline has only 135 ms of margin over server p95 and is below server p99.
Therefore two client-visible recall timeouts are entirely plausible even when
the Worker ultimately logs HTTP 200.

### Server-side timeout check

The route's own retrieval timeout is 30 seconds:

- `apps/api/src/features/search/constants.ts:114`
- `apps/api/src/features/search/routes.ts:385`

No `retrieval.request_failed` with status 504 was observed. The failures in that
event family were embedding/database/search errors, not route timeout events.
The reported two timeouts were therefore most likely enforced by the Crosmos
client's three-second deadline.

### Did the event complete triage and enter the outbox?

The current evidence supports only a partial answer:

- Fail-open is credible because search can time out client-side while
  replies/events continue independently.
- Conversation ingestion continued across the review: 292 conversation
  requests returned 202 and 293 observed ingestion jobs reached a terminal
  state overall.
- There are no literal `triage` or `outbox` lifecycle events in either Worker's
  logs or in this repository's backend paths.
- The API's `ingestion.enqueue_accepted` event logs `space_id`,
  `source_count`, and duration, but omits the already-available `jobId` and
  `correlationId` (`apps/api/src/features/conversations/routes.ts:212` and
  `:242`).

It is therefore **not possible to prove that the exact user-reported event**
completed triage or entered the outbox from these logs alone. An exact
timestamp, request ID, invocation ID, session ID, event ID, or job ID could
narrow the search, but the missing correlation fields may still prevent an
end-to-end proof.

Required observability improvement:

- propagate one logical event/correlation ID through recall, reply/event
  creation, conversation enqueue, triage, outbox enqueue, and outbox delivery;
- include `job_id`, `correlation_id`, and `session_id` in
  `ingestion.enqueue_accepted`;
- emit explicit `triage.completed`, `outbox.enqueued`, and
  `outbox.delivered` events in whichever service owns those stages.

If recall is deliberately best-effort, keeping a three-second fail-open budget
is reasonable, but the client should not synchronously retry it. If completing
recall is more important than that latency budget, a five-second deadline would
cover more than 99% of the observed successful population, though background
recall/prefetch and caching are better long-term options.

## Ingestion Worker findings

The ingestion Worker itself had no failed invocation outcomes in the reviewed
telemetry. Of 293 observed jobs:

- 269 completed;
- 24 reached failed terminal status.

The 24 terminal failures were:

- 23 `chunks_space_id_memory_spaces_id_fk`;
- 1 `entities_space_id_memory_spaces_id_fk`.

The API cancels jobs and immediately deletes the parent space:

- `apps/api/src/features/spaces/routes.ts:315`
- `apps/api/src/features/spaces/routes.ts:317`

The ingestion loop checks cancellation only between sources:

- `apps/ingestion/src/process-ingestion.ts:197`

A single source already being processed can therefore continue to a database
write after its parent space is deleted and hit a foreign-key violation. Use a
deletion/cancellation barrier or lease coordination, and check cancellation or
parent existence immediately before durable write stages. Parent deletion
should become a clean cancelled terminal result, not a retryable ingestion
error.

Five repeated OpenAI 503 rows represented two structured embedding failures
that were scheduled for retry. These do not explain the 24 terminal jobs.

The many second-attempt queue events are largely expected dual-trigger
behavior: a durable queue backstop checks jobs while the direct RPC kick is
active, finds the claim already owned, and requeues/skips safely. They should
not be interpreted as 267 independent ingestion failures.

## Scheduled-job reliability

Over 72 hours:

- `cron.jobs_reap_failed`: 68;
- `cron.ingestion_redrive_failed`: 7.

Most reaper failures were transient Hyperdrive “Network connection lost”
errors. These jobs run every 15 minutes and are isolated from one another in
`apps/api/src/index.ts:250` and `:259`, so a reaper error does not suppress
redrive. Add an idempotent, bounded retry for transient database connection
failures and alert on consecutive failures or stale-job growth rather than raw
single-attempt errors.

## Observability configuration

Historical logging is already enabled for both production Workers:

```toml
[env.production.observability]
enabled = true
head_sampling_rate = 1

[env.production.observability.logs]
enabled = true
head_sampling_rate = 1
persist = true
invocation_logs = true
```

The same is enabled for persisted traces. No redeploy is needed merely to turn
historical observability on.

At 100% sampling, each public search can produce request-start, gate-stage,
signal, embedding, completion/access, internal Durable Object, and platform
invocation rows. This explains why dashboard event volume is much larger than
public request volume. Preserve 100% error and invocation visibility, but
consider moving high-cardinality successful stage timings to Analytics Engine
and sampling routine info logs. Do not reduce error sampling blindly.

One MCP limitation was encountered: individual-event decoding fails for mixed
console rows that do not contain `$workers.outcome`. Calculations and filtered
invocation queries work. Signal-duration grouping also has a field/schema
collision. These are query-tool limitations, not Worker failures.

## Recommended remediation order

No recommendation below has been applied.

### P0 — stop recurrence and amplification

1. **Disable immediate automatic retry for recall 429/500/CPU-503 responses.**
   Keep the best-effort fail-open behavior and add client singleflight/cancel
   stale recall work.
2. **Verify and correct the production Worker's effective CPU limit.** If the
   effective allowance is 10 ms, move to an appropriate paid/configured limit,
   then profile CPU before selecting the final budget.
3. **Add a database-capacity circuit breaker.** Detect Neon account-budget
   exhaustion, fail fast with dependency-specific HTTP 503 and `Retry-After`,
   and page on the provider budget before exhaustion.
4. **Move cheap overload shedding earlier.** Avoid entitlement, quota, and
   multiple Durable Object calls for duplicate work that is already known to be
   over concurrency.

### P1 — make the system robust

5. Replace the concurrency counter with idempotent, tokenized expiring leases.
6. Consolidate or eliminate redundant limiter Durable Object calls.
7. Bound/sanitize full-text lexemes and fail the keyword signal soft on tsquery
   complexity.
8. Coordinate space deletion with in-flight ingestion and recheck cancellation
   immediately before writes.
9. Add bounded retries and consecutive-failure alerts for transient cron
   database failures.

### P2 — make future incidents provable and cheaper to diagnose

10. Carry one correlation ID through recall, ingestion, triage, and outbox; log
    job/session IDs at acceptance.
11. Split dashboards into public fetch invocations, internal Durable Object
    calls, application errors, and log-row volume.
12. Move successful stage distributions to metrics and sample verbose routine
    logs while retaining full error/invocation telemetry.
13. Alert separately on HTTP outcome, Cloudflare outcome (`exceededCpu`), 429
    stage, provider budget, retry ratio, and concurrency lease age.

## Verification targets after remediation

A follow-up load test should demonstrate:

- retry traffic below 5% of public search invocations during overload;
- zero duplicate in-flight recalls per session/query;
- no concurrency lease older than its request deadline plus grace period;
- no CPU terminations at the chosen Worker limit;
- provider-budget failures mapped to fast 503s rather than generic 500s;
- fewer than two admission Durable Object calls for a rejected search;
- p95 end-to-end successful recall comfortably below the client deadline;
- exact correlation from client event to ingestion job, triage, outbox enqueue,
  and delivery;
- parent-space deletion results in cancelled ingestion, not foreign-key errors.
