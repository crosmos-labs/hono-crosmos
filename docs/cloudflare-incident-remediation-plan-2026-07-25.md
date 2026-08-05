# Prioritized remediation plan — Cloudflare incident, 25 July 2026

Status: proposed work only. This document does not apply any code,
configuration, deployment, billing, or production-data changes.

> **Superseded in part.** Part of this plan was implemented on 2026-08-05. See
> [`cloudflare-incident-remediation-status-2026-08-05.md`](./cloudflare-incident-remediation-status-2026-08-05.md)
> for what shipped, what remains, and two corrections to the analysis below —
> most importantly that **P0-3 (Worker CPU allowance) rests on a false premise
> and should be dropped**, and that the 3s/30s timeout mismatch filed here as
> P1-5 was the primary amplifier rather than a documentation item.

Related analysis:
[`cloudflare-observability-incident-2026-07-25.md`](./cloudflare-observability-incident-2026-07-25.md)

## Objective

Prevent a repeat of the `/api/v1/search` failure cascade, reduce the cost of
overload, make best-effort recall predictable, fix the ingestion correctness
issues found in the same review, and make a future event traceable from the
Crosmos client through triage and outbox delivery.

The remediation order is driven by:

1. user impact and recurrence risk;
2. ability to stop traffic amplification;
3. protection of shared dependencies;
4. correctness and data-integrity risk;
5. diagnostic value.

## Priority definitions

- **P0 — immediate:** prevents another broad outage or retry cascade. Complete
  before increasing traffic.
- **P1 — next:** removes structural failure modes and correctness problems.
  Begin after P0 safeguards are deployed.
- **P2 — hardening:** improves observability, efficiency, and long-term
  operability.

## Summary

| ID | Priority | Fix | Primary area | Size | Main outcome |
|---|---|---|---|---|---|
| P0-1 | P0 | Stop harmful recall retries | Crosmos SDK/client | S | Removes up to 45% duplicated incident traffic |
| P0-2 | P0 | Add recall singleflight and stale-request cancellation | Crosmos client | M | One logical recall cannot create concurrent duplicates |
| P0-3 | P0 | Verify and set an appropriate Worker CPU allowance | Cloudflare/platform | S–M | Stops low-millisecond CPU terminations |
| P0-4 | P0 | Add Neon capacity alerts and an exhaustion circuit breaker | API/platform | M | Provider exhaustion becomes fast, controlled 503 |
| P0-5 | P0 | Shed overloaded searches earlier | API admission path | M | Rejected work avoids database and limiter cost |
| P0-6 | P0 | Classify dependency failures consistently | API | M | Removes generic/retryable-looking 500s |
| P1-1 | P1 | Replace counters with idempotent concurrency leases | API/Durable Objects | L | CPU-killed requests cannot leak or duplicate slots |
| P1-2 | P1 | Consolidate redundant admission subrequests | API/Durable Objects | L | Reduces the current 3.77+ internal calls/search |
| P1-3 | P1 | Bound full-text query complexity and fail signals soft | Retrieval/API | M | Pathological queries cannot fail all retrieval |
| P1-4 | P1 | Coordinate space deletion with ingestion | API/ingestion | L | Removes deletion-related foreign-key failures |
| P1-5 | P1 | Formalize the recall timeout/fail-open contract | Client/API | M | Predictable behavior at the three-second deadline |
| P1-6 | P1 | Add bounded retries to scheduled DB jobs | API/cron | S–M | Transient Hyperdrive failures do not accumulate |
| P1-7 | P1 | Harden transient AI/vector dependency handling | API/ingestion | M | Safe retry/degradation without retry storms |
| P1-8 | P1 | Fix write-side usage races | API/database | M | Successful searches stop producing FK warnings |
| P2-1 | P2 | Add end-to-end event correlation | All services | L | Proves recall, ingestion, triage, and outbox state |
| P2-2 | P2 | Separate request, internal-call, and log-volume dashboards | Observability | M | Dashboard counts represent user impact correctly |
| P2-3 | P2 | Move routine timings to metrics and tune log sampling | Observability | M | Lower log volume with complete error evidence |
| P2-4 | P2 | Add SLO-based alerts and incident runbooks | Platform | M | Earlier detection and consistent response |
| P2-5 | P2 | Add overload, deletion-race, and dependency-failure tests | QA/platform | L | Remediations remain effective after future changes |

Sizes are relative estimates: S is a focused change, M crosses a few components,
and L needs design/migration or coordinated rollout.

## P0 — immediate outage prevention

### P0-1. Stop harmful automatic retries in recall

**Problem**

During the incident, 9,178 of 20,304 search invocations were automatic retries.
They added 82.5% traffic relative to initial requests, but only 5.08% returned
HTTP 200.

**Required behavior**

- Do not automatically retry synchronous recall after:
  - concurrency HTTP 429;
  - deterministic provider-capacity/budget failure;
  - Cloudflare CPU-limit 503;
  - generic retrieval 500 without an explicitly retryable error code.
- Preserve retries only for narrowly classified, transient, idempotent failures.
- When a 429 is intentionally retried outside the reply-critical path:
  - honor `Retry-After`;
  - add randomized jitter;
  - cap attempts;
  - cancel when the originating reply/event is no longer current.
- Send a stable logical invocation ID across any permitted retry.

**Affected area**

- Crosmos JavaScript SDK/client request policy.
- Recall orchestration that currently uses the Stainless-generated client.
- API error envelopes, because the client needs machine-readable failure
  categories.

**Acceptance criteria**

- Overload test retry traffic is below 5% of public search invocations.
- Concurrency 429, deterministic provider exhaustion, and CPU-limit responses
  create zero immediate synchronous retries.
- One failed recall never delays or blocks reply/event continuation.
- Retry decisions are test-covered by HTTP status and machine error code.

**Rollout**

Deploy behind a client feature flag if possible. Start with recall only, observe
retry ratio and recall success, then apply the policy to other idempotent API
calls where appropriate.

### P0-2. Add singleflight, debouncing, and stale-request cancellation

**Problem**

Multiple logical recalls for the same user/session can overlap. Each overlap
consumes a concurrency slot and may initiate another embedding/retrieval fanout.

**Required behavior**

- Permit at most one active recall per session/conversation and logical query.
- Coalesce identical concurrent requests onto one promise/result.
- When a newer user event supersedes an older recall, cancel or ignore the old
  result.
- Do not start a second request merely because the first crossed a local UI
  timing threshold.
- Include a stable `event_id` or `recall_id` with the request.

**Acceptance criteria**

- A burst of identical recall triggers results in one public `/search`
  invocation.
- A superseding event cancels/invalidates the previous result.
- No stale recall result is attached to a newer reply.
- Client metrics expose attempted, coalesced, cancelled, timed-out, and
  completed recalls.

### P0-3. Verify and correct the Worker CPU allowance

**Problem**

Cloudflare terminated 2,919 search invocations for CPU. Terminations clustered
in the low tens of milliseconds. No `limits.cpu_ms` is set in
`apps/api/wrangler.toml`, suggesting the effective account/plan default may be
too low for hybrid retrieval.

**Required work**

1. Verify the production account plan and the effective CPU allowance in the
   Cloudflare dashboard.
2. Record the current setting in the operational runbook.
3. If the limit is approximately 10 ms, choose a paid/configured CPU budget that
   covers measured p99 with headroom.
4. Profile CPU before choosing the final value:
   - structured serialization/logging;
   - signal fusion and candidate mapping;
   - reranking preparation;
   - response construction;
   - large query/result behavior.
5. Configure the smallest safe budget rather than defaulting to the maximum
   permitted value.

Cloudflare reference:
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[`limits.cpu_ms` configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits).

**Acceptance criteria**

- The effective production CPU limit is known and documented.
- The incident replay/load test produces zero `exceededCpu` outcomes.
- Configured CPU budget is above measured p99 plus agreed safety margin.
- CPU p95/p99 is graphed by route and release.
- An alert fires on any sustained CPU-termination rate above the agreed
  threshold.

**Risk**

Increasing the allowance can hide inefficient code and increase cost. It must
be paired with profiling and a regression threshold.

### P0-4. Protect against Neon capacity/budget exhaustion

**Problem**

Neon account usage exhaustion was the dominant HTTP 500 cause. Requests
continued through admission and then failed with a generic unhandled error even
though the provider stated that service would not recover until a known renewal
time.

**Required behavior**

- Monitor the database account's usage, compute, storage, and connection
  allowances.
- Alert before exhaustion at two thresholds, for example warning and critical.
- Classify provider account exhaustion separately from transient connection
  failure.
- Open a short-lived circuit breaker after confirmed exhaustion:
  - skip database-backed work that cannot succeed;
  - return HTTP 503, not 500;
  - return a machine code such as `database_capacity_unavailable`;
  - include a conservative `Retry-After`;
  - prevent the SDK from immediate retry.
- Half-open the circuit with a small probe rate and close it only after a
  successful database operation.
- Confirm the production plan has enough capacity for expected peak and failure
  traffic.

**Affected code**

- Top-level handler at `apps/api/src/index.ts:157`.
- Database/Hyperdrive client wrapper and failure classification.
- Search gates that currently perform database work before overload rejection.

**Acceptance criteria**

- A simulated provider-budget error returns classified HTTP 503 within the
  agreed fast-fail budget.
- The same simulated error does not create automatic client retries.
- Capacity alerts fire before hard exhaustion.
- Circuit state and rejected request counts are visible in metrics.
- Recovery probes close the circuit without a deploy.

### P0-5. Shed overload earlier and more cheaply

**Problem**

The concurrency guard currently follows authentication, entitlements, space
access, a plan limiter, and monthly quota. A rejected search still averaged
128 ms wall time and 7.17 ms CPU.

**Required design**

- Authentication and tenant isolation remain mandatory.
- Immediately after a cheap authenticated principal is known, apply a coarse
  overload/singleflight gate before database-backed entitlement and quota work.
- Preserve authoritative space authorization and quota checks for work that is
  admitted.
- Do not count a cheap early rejection as consumed AI quota.
- Return `Retry-After` on concurrency rejection.
- Do not expose whether a space exists through the early gate.

Relevant path:
`apps/api/src/features/search/routes.ts:198` through `:315`.

**Acceptance criteria**

- A concurrency-rejected request performs fewer than two admission Durable
  Object calls.
- Rejection p95 is materially below the current 154 ms baseline.
- No database, embedding, vector, or reranking work starts for early-rejected
  traffic.
- Authorization and cross-tenant non-disclosure tests continue to pass.
- Quota and rate-limit accounting remains correct.

### P0-6. Return machine-readable dependency failures

**Problem**

Database/provider failures reach `api.unhandled_error` and become generic 500s.
This prevents correct client retry decisions and makes alerting imprecise.

**Required behavior**

Create a stable failure taxonomy, for example:

| Failure | HTTP | Machine code | Retry guidance |
|---|---:|---|---|
| User concurrency full | 429 | `search_concurrency_limit` | Retry only after `Retry-After`; not in synchronous recall |
| Global AI capacity | 429/503 | `ai_capacity_unavailable` | Bounded delayed retry |
| Database account exhausted | 503 | `database_capacity_unavailable` | No immediate retry |
| Transient DB connection loss | 503 | `database_temporarily_unavailable` | Bounded retry outside critical path |
| Worker/retrieval timeout | 504 | `search_timeout` | Fail open; optional background retry |
| Invalid/pathological query | 400 or degraded 200 | `query_too_complex` | Do not retry unchanged |
| Unexpected internal defect | 500 | `internal_error` | Do not automatically retry by default |

Responses must retain a request/correlation ID without exposing internal error
messages or stacks.

**Acceptance criteria**

- Known dependency conditions no longer appear as `api.unhandled_error`.
- Client retry tests use the machine code, not status alone.
- Dashboards group failures by dependency and machine code.
- Unknown exceptions still return a safe generic 500.

## P1 — structural reliability and correctness

### P1-1. Use idempotent, tokenized concurrency leases

**Problem**

The current Durable Object limiter increments by user and releases by user. A
Worker killed for CPU may never release. A retry of the same logical request can
consume another slot, and a late release is not tied to the lease it created.

Relevant implementation:
`apps/api/src/features/search/concurrency.ts:109`.

**Required design**

- Acquire using `user_id + logical_recall_id`.
- Return a unique lease token and expiry.
- Reacquiring the same logical ID returns the existing lease rather than
  incrementing.
- Release requires the matching lease token.
- Use a Durable Object alarm or stored expirations to reclaim abandoned leases.
- Set lease expiry to request deadline plus a small cleanup grace period.
- Expose active lease count and oldest lease age.

**Acceptance criteria**

- Ten retries of one logical request consume one slot.
- CPU-killed test requests recover their leases without manual intervention.
- A late release cannot decrement another request's lease.
- Active count never becomes negative or exceeds the configured cap.
- Migration does not strand counters from the previous scheme.

### P1-2. Consolidate admission Durable Object calls

**Problem**

The incident produced at least 76,567 identified internal Durable Object fetches
for 20,304 public searches. Roughly three rate-limiter calls occurred per
search, before database/vector/AI subrequests.

**Required work**

- Map every `https://ratelimit/limit` caller and its scope.
- Determine whether the management auth limit is redundant on the stricter
  search path.
- Consider a composite admission request that evaluates compatible principal,
  plan, global, and concurrency state in one round-trip.
- Avoid creating counters for rejected duplicate logical recalls.
- Preserve independent keys/scopes where consistency or tenant fairness
  requires them.

**Acceptance criteria**

- Successful and rejected search subrequest budgets are documented.
- Normal search admission uses the agreed reduced number of Durable Object
  calls.
- A rejected search stays under the P0-5 subrequest target.
- Rate, quota, and noisy-neighbor tests show no enforcement regression.

### P1-3. Bound full-text query complexity and fail signals soft

**Problem**

`websearch_to_tsquery` produced `tsquery stack too small`. One auxiliary keyword
or graph signal can currently fail the whole hybrid request.

Relevant code:

- `apps/api/src/features/search/signals/keyword.ts:19`
- `apps/api/src/features/search/candidates.ts:78`

**Required behavior**

- Normalize whitespace and collapse repeated tokens.
- Define maximum query bytes, tokens, token length, and graph seed terms.
- Avoid constructing an unbounded OR expression.
- Catch known PostgreSQL query-complexity errors at the signal boundary.
- Continue retrieval using semantic/temporal/other healthy signals.
- Log and metric the degraded signal without logging sensitive query text.
- Return a client validation error only when no safe interpretation is possible.

**Acceptance criteria**

- Replays of the offending query class cannot produce a Worker 500.
- Oversized/repeated-token fuzz tests stay within CPU and database-query limits.
- Keyword degradation still allows a valid hybrid response when other signals
  succeed.
- Signal degradation is visible in metrics.

### P1-4. Coordinate space deletion with in-flight ingestion

**Problem**

Twenty-four terminal ingestion jobs failed because their parent memory space was
deleted while processing. The API cancels then immediately deletes the space,
but ingestion checks cancellation only between sources.

Relevant code:

- `apps/api/src/features/spaces/routes.ts:315`
- `apps/ingestion/src/process-ingestion.ts:197`

**Required design**

Choose and document one safe model:

1. **Deletion barrier:** mark the space deleting, cancel jobs, wait for active
   leases to drain, then delete.
2. **Write fencing:** every ingestion write verifies the job lease and parent
   generation/state transactionally.
3. **Deferred cleanup:** soft-delete first, let workers observe cancellation,
   then purge asynchronously.

Regardless of model:

- check cancellation/parent state immediately before durable write phases;
- classify parent deletion as `cancelled`, not `failed`;
- prevent retries of a definitively deleted parent;
- make repeated delete/cancel operations idempotent.

**Acceptance criteria**

- Deleting a space during every ingestion phase produces no foreign-key errors.
- Jobs and sources reach an intentional cancelled terminal state.
- No memory, entity, chunk, or vector data survives past completed deletion.
- Delete latency and cleanup state remain observable.

### P1-5. Formalize the recall timeout and fail-open contract

**Problem**

The client deadline is three seconds. Server p95 was 2.865 seconds and p99 was
4.388 seconds, so ordinary successful server work can appear as a client
timeout.

**Recommended contract**

- Keep reply generation independent of recall success.
- Treat recall as a strict best-effort dependency.
- At the client deadline:
  - stop waiting;
  - continue the reply/event;
  - cancel or ignore stale recall;
  - do not start an immediate duplicate.
- Prefer caching, prefetch, or asynchronous enrichment over simply increasing
  the deadline.
- If product requirements prioritize recall completeness, test a five-second
  deadline separately; do not silently change it without measuring reply
  latency.
- Align the server's 30-second timeout with actual useful work. Work continuing
  long after the client has abandoned it should be cancellable or have a shorter
  workload-specific ceiling.

**Acceptance criteria**

- The product decision—strict three-second fail-open or a longer
  completeness-oriented budget—is documented.
- A recall timeout never prevents reply/event continuation.
- Server work is cancelled or made reusable when the client abandons it.
- Metrics distinguish client deadline, server 504, dependency failure, and
  successful late completion.

### P1-6. Retry transient scheduled-job database failures safely

**Problem**

The 72-hour review found 68 `cron.jobs_reap_failed` and seven
`cron.ingestion_redrive_failed` events, mostly transient Hyperdrive connection
loss.

Relevant code:
`apps/api/src/index.ts:250` and `:259`.

**Required behavior**

- Retry only classified transient connection failures.
- Use a small bounded attempt count with exponential backoff and jitter.
- Keep reaper and redrive isolated.
- Ensure every operation is idempotent.
- Alert on consecutive complete cron failures and stale-job growth, not every
  first-attempt blip.

**Acceptance criteria**

- Injected transient connection loss recovers within one scheduled invocation.
- Permanent failures stop at the attempt budget and page with context.
- No job is reaped/redriven twice in a harmful way.
- Dashboard shows first-attempt failures separately from final cron outcomes.

### P1-7. Harden AI/vector dependency degradation

**Problem**

The review found OpenAI embedding failures, Qdrant 502s, and ingestion embedding
503s. They were not the main spike, but can cause individual search or ingestion
failure.

**Required behavior**

- Maintain a dependency-specific retry policy based on operation idempotency.
- Search:
  - fail a nonessential signal soft where result quality remains acceptable;
  - avoid retrying inside the reply-critical deadline if insufficient time
    remains.
- Ingestion:
  - preserve durable checkpoints;
  - retry transient provider failure with a bounded queue schedule;
  - do not terminally fail until the durable retry budget is exhausted.
- Apply circuit breakers and concurrency limits per provider.
- Record provider, status, attempt, and final outcome without sensitive payloads.

**Acceptance criteria**

- Provider 502/503 injection does not cause an unbounded retry loop.
- Search either succeeds in a documented degraded mode or returns a classified
  dependency response.
- Ingestion resumes from its checkpoint without duplicate durable records.
- Provider retry and final-failure rates are visible.

### P1-8. Fix best-effort usage/write-side foreign-key races

**Problem**

Search bookkeeping produced
`daily_usage_space_id_memory_spaces_id_fk` failures when the space disappeared
between retrieval and background metering.

Relevant path:
`apps/api/src/features/search/routes.ts:443`.

**Required behavior**

- Decide whether usage survives parent deletion or is intentionally discarded.
- Make the database schema/write match that policy:
  - transactional existence check/upsert;
  - deletion-safe foreign-key behavior; or
  - organization-level metering independent of the deleted space.
- Treat an expected deletion race as a measured no-op, not a noisy warning.
- Preserve the rule that bookkeeping cannot fail a successful search response.

**Acceptance criteria**

- Search/delete race tests produce no FK errors.
- Usage accounting remains correct according to the documented deletion policy.
- Background write failure never changes the already-produced HTTP response.

## P2 — observability and operational hardening

### P2-1. Add end-to-end correlation through triage and outbox

**Problem**

The reported Crosmos event could not be proven to have completed triage or
entered the outbox. Those lifecycle events are absent, and
`ingestion.enqueue_accepted` omits available job/correlation identifiers.

**Required fields**

- `event_id`
- `recall_id`
- `request_id`
- `correlation_id`
- `session_id`
- `job_id`
- `source_id`

Use only identifiers safe for logs; do not log user content or secrets.

**Required events**

- `recall.started`
- `recall.completed`, `recall.timed_out`, or `recall.failed_open`
- `ingestion.enqueue_accepted`
- `ingestion.job_claimed`
- `ingestion.job_completed` or terminal failure/cancellation
- `triage.completed`
- `outbox.enqueued`
- `outbox.delivered` or terminal delivery failure

Relevant acceptance log:
`apps/api/src/features/conversations/routes.ts:242`.

**Acceptance criteria**

- Given one event ID, an operator can determine every stage and final state with
  one historical query.
- One logical event retains the same correlation ID across retry and queue
  boundaries.
- Missing stages can be alerted as stalled lifecycle transitions.

### P2-2. Separate user requests from internal and logging events

**Problem**

The Cloudflare “Events” graph combines public fetches, Durable Object calls,
structured logs, and duplicated failure rows. It cannot represent the HTTP
success rate directly.

**Required dashboards**

1. Public route invocations by route, HTTP status, and Cloudflare outcome.
2. Search rejection by exact admission stage.
3. Internal Durable Object calls by endpoint and public-request correlation.
4. Dependency failures by provider/category.
5. Ingestion job final outcomes, not queue delivery attempts.
6. Log/event volume and sampling separately from requests.

**Acceptance criteria**

- Dashboard HTTP counts reconcile with narrow invocation queries.
- Cloudflare `exceededCpu` is visible separately from application HTTP 503.
- Retry count and unique logical-request count are shown side by side.
- Durable backstop claim skips are not displayed as ingestion failures.

### P2-3. Move routine stage data to metrics and tune logging

**Problem**

Observability is persisted at 100% sampling. A successful search emits many
stage and platform events, inflating volume and potentially adding CPU cost.

**Required behavior**

- Keep error and invocation outcomes at full fidelity.
- Move high-volume successful stage durations to Analytics Engine or an
  equivalent metrics path.
- Sample routine info logs by route/environment, with the rate recorded.
- Retain unsampled logs for:
  - failed requests;
  - CPU terminations where available;
  - dependency circuit changes;
  - job terminal outcomes;
  - security/audit events.
- Benchmark CPU and wall time before and after the logging change.

**Acceptance criteria**

- Error investigations retain request-level evidence.
- Successful-stage distributions remain available at p50/p95/p99.
- Log volume per successful search is reduced by an agreed target.
- Search CPU does not regress because of observability serialization.

### P2-4. Establish SLO alerts and runbooks

Create independent alerts for:

- public search non-200 rate;
- concurrency 429 ratio;
- unique logical requests versus retries;
- Cloudflare CPU terminations;
- p95/p99 successful recall latency;
- Neon capacity and circuit-breaker state;
- embedding/vector provider failure;
- oldest concurrency lease;
- cron final failure and stale jobs;
- ingestion terminal failure;
- outbox age/delivery failure.

Each alert needs a runbook containing:

- user impact;
- validation query;
- likely failure classes;
- safe mitigation;
- rollback/escalation conditions;
- owner and communication channel.

**Acceptance criteria**

- A staged replay of each incident class triggers the correct alert.
- The alert distinguishes retry amplification from new user traffic.
- On-call can identify the failing dependency and safe first action without
  reading application source.

### P2-5. Add regression, load, and failure-injection coverage

Required scenarios:

- sustained per-user recall burst;
- duplicate logical recall with retries;
- Worker termination before concurrency release;
- Neon budget exhaustion and connection loss;
- long/repeated-token tsquery input;
- embedding/vector 502/503;
- space deletion during every ingestion phase;
- queue backstop racing direct RPC;
- client timeout while server later succeeds;
- triage/outbox lifecycle interruption.

**Acceptance criteria**

- The P0/P1 acceptance criteria run automatically in staging.
- The load test records public requests, unique logical requests, retries,
  internal subrequests, CPU, wall time, and dependency calls.
- Failure injection leaves no stuck concurrency lease, job, source, or outbox
  item.

## Recommended implementation sequence

### Wave 0 — establish guardrails

1. Confirm the effective Worker CPU limit.
2. Add/verify Neon capacity alerts.
3. Capture current baselines for retry ratio, CPU outcomes, search latency,
   concurrency rejection latency, and Durable Object calls.

This wave is operational/read-only except for alerts and documentation.

### Wave 1 — remove amplification

1. P0-1: retry policy.
2. P0-2: singleflight/cancellation.
3. P0-6: stable error taxonomy required by the client policy.
4. P0-4: database circuit breaker.

Deploy client retry and server error classification compatibly: older clients
must continue to receive valid status codes, while newer clients consume the
machine code.

### Wave 2 — stabilize admission and CPU

1. P0-3: deploy the verified CPU setting with profiling.
2. P0-5: early overload shedding.
3. P1-1: idempotent leases.
4. P1-2: limiter consolidation.

Roll out lease/admission changes behind a server feature flag or percentage
split, compare counts with the old limiter, then migrate fully.

### Wave 3 — correctness

1. P1-3: query complexity.
2. P1-4: deletion/ingestion coordination.
3. P1-6/P1-7: dependency retry policy.
4. P1-8: usage-write race.
5. P1-5: final timeout contract after new latency data is available.

### Wave 4 — provability and continuous validation

1. P2-1: lifecycle correlation.
2. P2-2/P2-3: dashboards, metrics, and logging.
3. P2-4: SLO alerts/runbooks.
4. P2-5: automated load and failure-injection suite.

## Release and rollback rules

For every production change:

- establish a before/after dashboard;
- deploy to staging with incident replay;
- use a feature flag, canary, or percentage rollout where feasible;
- define one measurable success threshold and rollback threshold;
- do not combine the CPU-limit change, limiter migration, and retry-policy
  change in one unobservable release;
- preserve the ability to disable new admission behavior without a code revert;
- confirm that fail-open behavior does not become fail-silent—every degradation
  still emits a metric.

Suggested immediate rollback signals:

- increased cross-tenant authorization failures;
- unexpected quota bypass;
- search p95 or CPU regression above the agreed limit;
- negative/stuck concurrency lease counts;
- ingestion jobs stuck outside a terminal state;
- retry traffic returning toward incident levels.

## Completion criteria

The incident can be considered fully remediated when:

- automatic retry traffic stays below 5% during overload;
- duplicate logical recalls do not create duplicate searches;
- CPU terminations are zero in incident replay and negligible in production;
- Neon exhaustion fails fast as classified 503 without a retry storm;
- rejected searches avoid expensive dependency work;
- concurrency slots are idempotent and self-reclaiming;
- pathological queries degrade safely;
- space deletion cannot create ingestion FK failures;
- client timeout behavior is documented and measured;
- scheduled transient failures recover within their bounded retry policy;
- a single event ID proves ingestion, triage, outbox enqueue, and delivery;
- dashboards distinguish public requests from internal/log events;
- all scenarios are covered by repeatable staging tests and runbooks.

