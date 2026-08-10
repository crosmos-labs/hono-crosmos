# Prioritized remediation plan — Cloudflare incident, 25 July 2026

Status: **partially implemented.** Tracked as a checklist below; last updated
2026-08-05.

> **Superseded in part.** Eight items were implemented and **deployed to
> production on 2026-08-05** (`crosmos-api-production` version `34adf955`). See
> [`cloudflare-incident-remediation-status-2026-08-05.md`](./cloudflare-incident-remediation-status-2026-08-05.md)
> for the shipped detail, and two corrections to the analysis below —
> most importantly that **P0-3 (Worker CPU allowance) rests on a false premise
> and should be dropped**, and that the 3s/30s timeout mismatch filed here as
> P1-5 was the primary amplifier rather than a documentation item.

Related analysis:
[`cloudflare-observability-incident-2026-07-25.md`](./cloudflare-observability-incident-2026-07-25.md)

### Reading the checklist

- `[x]` — implemented **and** deployed to production.
- `[~]` — partially done; the remainder is called out on the item.
- `[ ]` — not started.
- `[-]` — dropped, with the reason on the item.

**Shipped is not the same as verified.** The repository has no automated
coverage of the API admission path, and the post-deploy check has so far only
confirmed the limiter consolidation against live traffic. Per-item *acceptance
criteria* therefore remain unticked until a load test exercises them — see
**P2-5** below, which is the
single highest-value remaining item.

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

| | ID | Priority | Fix | Size | Commit | Notes |
|---|---|---|---|---|---|---|
| `[x]` | P0-1 | P0 | Stop harmful recall retries | S | `74906d2` | Done **server-side** via `x-should-retry`; no SDK release needed |
| `[ ]` | P0-2 | P0 | Recall singleflight and stale-request cancellation | M | — | Client-side. Server half (`leaseKey`) shipped and inert |
| `[-]` | P0-3 | P0 | Verify and set a Worker CPU allowance | S–M | — | **Dropped** — premise refuted; account is paid, limit is 30s |
| `[~]` | P0-4 | P0 | Neon capacity alerts + exhaustion circuit breaker | M | `78eec89` | Classification shipped; **breaker and alerts outstanding** |
| `[x]` | P0-5 | P0 | Shed overloaded searches earlier | M | `65d0717` | Rejection cost 6 DO calls → 1 |
| `[x]` | P0-6 | P0 | Classify dependency failures consistently | M | `78eec89` | |
| `[x]` | P1-1 | P1 | Idempotent concurrency leases | L | `55b6d4d` | Tokenized; idempotent-by-logical-id ready but needs a client id |
| `[x]` | P1-2 | P1 | Consolidate redundant admission subrequests | L | `261742d` | 7 → 4 per search. **Confirmed on live traffic** |
| `[x]` | P1-3 | P1 | Bound query complexity and fail signals soft | M | `5b9649e` `7e5683b` | Two independent defenses |
| `[ ]` | P1-4 | P1 | Coordinate space deletion with ingestion | L | — | **Blocked on a design decision** (see item) |
| `[x]` | P1-5 | P1 | Formalize the recall timeout/fail-open contract | M | `f2beb5c` | 30s → 6s. The primary amplifier |
| `[ ]` | P1-6 | P1 | Bounded retries for scheduled DB jobs | S–M | — | |
| `[~]` | P1-7 | P1 | Harden transient AI/vector dependency handling | M | `5b9649e` | Search side degrades soft; ingestion side untouched |
| `[ ]` | P1-8 | P1 | Fix write-side usage races | M | — | **Blocked on a policy decision** (see item) |
| `[ ]` | P2-1 | P2 | End-to-end event correlation | L | — | |
| `[ ]` | P2-2 | P2 | Separate request/internal-call/log-volume dashboards | M | — | |
| `[ ]` | P2-3 | P2 | Move routine timings to metrics, tune log sampling | M | — | **Blocked:** `ANALYTICS` binding still commented out |
| `[ ]` | P2-4 | P2 | SLO-based alerts and incident runbooks | M | — | Depends on P2-3 |
| `[ ]` | P2-5 | P2 | Overload, deletion-race, dependency-failure tests | L | — | **Highest-value remaining item** |

Sizes are relative estimates: S is a focused change, M crosses a few components,
and L needs design/migration or coordinated rollout.

**Progress: 7 of 19 done, 2 partial, 1 dropped, 9 not started.** All shipped
items went to production together on 2026-08-05 as version `34adf955`.

### Blocked on a decision from the owner

These two cannot start until the question is answered:

- [ ] **P1-4** — is space deletion a barrier, write-fencing, or soft-delete plus
      async purge? (Recommendation: soft-delete.)
- [ ] **P1-8** — does `daily_usage` survive its parent space being deleted? If
      billing needs the history, meter at org level; if not, cascade.

### Not in the original plan, found during implementation

- [ ] **Enable the Analytics Engine binding.** `[[analytics_engine_datasets]]`
      is commented out in `apps/api/wrangler.toml` for both `production` and the
      top-level env, so **every `metrics.count()` call is a no-op in
      production** — including the throttle/degradation metrics these fixes
      emit. Logs work; metrics do not. This gates P2-3 and P2-4.
- [ ] **Run the post-deploy verification.** `scripts/verify-incident-fixes.ts`
      (`fff3cf0`) needs a prod API key and space id. Until it runs, the search
      path changes are deployed but unverified.
- [ ] **Plan the migration off Stainless.** The company is winding down. The
      `x-should-retry` lever used by P0-1 is a property of the generated client,
      so whatever replaces it must preserve that behavior or P0-1 regresses.

## P0 — immediate outage prevention

### [x] DONE — P0-1. Stop harmful automatic retries in recall

> **Status.** Shipped `74906d2`, deployed 2026-08-05. Implemented **server-side** rather than in the SDK: the Stainless client obeys an `x-should-retry` response header before any status-code rule, so the already-shipped client was fixed without a release. The client-side singleflight half is **P0-2** and remains open.

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

### [ ] NOT STARTED — P0-2. Add singleflight, debouncing, and stale-request cancellation

> **Status.** Client-side work, in `../crosmos-ts-sdk` / `../crosmos-python-sdk`. The **server half is shipped**: `RateLimiterDO.acquire` accepts an optional `leaseKey` that makes acquisition idempotent per logical request, so retries of one recall consume one slot. It is inert until a client sends a stable recall id.

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

### [-] DROPPED — P0-3. Verify and correct the Worker CPU allowance

> **Status.** **The premise is refuted — do not action this.** The account export shows 34/34 searches succeeding at 37 ms median / 84 ms max CPU, so the effective limit is not the inferred 10 ms. Hyperdrive, Queues, Smart Placement and SQLite-backed Durable Objects are all Workers *Paid* features and all are in use, so the limit is the paid 30 s default and `limits.cpu_ms` would be a no-op. CPU-*terminated* invocations also burned **less** CPU (12.5 ms avg) than successful ones — they were stalled on I/O during the database outage, making them a symptom rather than a cause.

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

### [~] PARTIAL — P0-4. Protect against Neon capacity/budget exhaustion

> **Status.** The **classification** half shipped as part of `78eec89` (see **P0-6**): provider-budget exhaustion now returns a classified 503 with a `Retry-After` parsed from the provider's own stated renewal time, and `x-should-retry: false`. **Still outstanding:** the circuit breaker itself (needs shared cross-isolate state, so a Durable Object) and the capacity alerts. Lower urgency than the plan implies, because classification already removed the retry amplification; the breaker now only saves wasted work.

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

### [x] DONE — P0-5. Shed overload earlier and more cheaply

> **Status.** Shipped `65d0717`, deployed 2026-08-05. The concurrency gate moved ahead of entitlements, space access, the plan limiter and the quota. A rejected search went from 6 Durable Object calls to **1**, and no longer consumes monthly AI quota it never used.

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

### [x] DONE — P0-6. Return machine-readable dependency failures

> **Status.** Shipped `78eec89`, deployed 2026-08-05. Implemented in `apps/api/src/lib/dependency-errors.ts`, applied in both the global `onError` handler and the search route (which wraps errors in a 500 before the global handler sees them). Deliberately conservative: anything not matching a known provider condition stays a 500.

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

### [x] DONE — P1-1. Use idempotent, tokenized concurrency leases

> **Status.** Shipped `55b6d4d`, deployed 2026-08-05. Slots are now a `Map<leaseToken, expiry>`; release deletes exactly the caller's token. The previous `slots.shift()` dropped the *oldest* lease, so a fast request freed a slow request's still-live slot. Acquire-by-`leaseKey` is implemented for the idempotency requirement but needs a client-supplied recall id (see P0-2).

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

### [x] DONE — P1-2. Consolidate admission Durable Object calls

> **Status.** Shipped `261742d`, deployed 2026-08-05. **Confirmed against live production traffic:** two real `POST /api/v1/conversations` requests each made exactly 2 limiter calls where the old code made 4. Note the plan's "3.77 calls/search" undercounts — the measured figure was **7.03**; it is now 4 per search and 1 per rejection.

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

### [x] DONE — P1-3. Bound full-text query complexity and fail signals soft

> **Status.** Shipped as two independent defenses, both deployed 2026-08-05. `5b9649e` makes the signal fan-out `allSettled` so an auxiliary signal degrades instead of failing the search; `7e5683b` bounds both `websearch_to_tsquery` call sites so the query is rarely pathological in the first place. Semantic is treated as essential and still throws — a keyword-only result would hand an agent bad recall to answer confidently from.

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

### [ ] BLOCKED — needs a decision — P1-4. Coordinate space deletion with in-flight ingestion

> **Status.** **Cannot start until the model is chosen.** Recommendation: **deferred cleanup** (soft-delete, let workers observe cancellation, purge asynchronously) — it is the only one of the three that neither adds latency to `DELETE /spaces` nor requires ingestion to hold a lease across invocations.

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

### [x] DONE — P1-5. Formalize the recall timeout and fail-open contract

> **Status.** Shipped `f2beb5c`, deployed 2026-08-05. **This was the primary amplifier, not a documentation item.** Server deadline 30 s → 6 s, with the concurrency slot TTL now *derived* as timeout + 4 s grace so the two cannot drift apart again. Per-user throughput ceiling went from 10 slots / 30 s ≈ 0.33 req/s to ≈ 1.67 req/s. Env-tunable via `RETRIEVAL_TIMEOUT_SECONDS`, so it reverts without a redeploy. The client-side deadline decision is unchanged at 3 s.

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

### [ ] NOT STARTED — P1-6. Retry transient scheduled-job database failures safely

> **Status.** Unchanged from the plan. These jobs are isolated from each other and self-heal on the next 15-minute tick, which is why this sits below the blocked items in priority.

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

### [~] PARTIAL — P1-7. Harden AI/vector dependency degradation

> **Status.** The **search** side is covered by `5b9649e`: a nonessential signal now fails soft rather than failing the request. **Still outstanding:** the ingestion side (durable checkpoint retry budgets), per-provider circuit breakers and concurrency limits, and the provider retry/outcome metrics.

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

### [ ] BLOCKED — needs a decision — P1-8. Fix best-effort usage/write-side foreign-key races

> **Status.** **Cannot start until the policy is set:** does usage survive its parent space being deleted? If billing needs the history, meter at org level and drop the space foreign key; if not, use deletion-safe FK behavior and treat the race as a measured no-op.

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

### [ ] NOT STARTED — P2-1. Add end-to-end correlation through triage and outbox

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

### [ ] NOT STARTED — P2-2. Separate user requests from internal and logging events

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

### [ ] BLOCKED — P2-3. Move routine stage data to metrics and tune logging

> **Status.** **The `ANALYTICS` binding is commented out** in `apps/api/wrangler.toml` for both the top-level and `production` envs, so every `metrics.count()` call — including the throttle and signal-degradation metrics the 2026-08-05 fixes emit — is a **no-op in production** today. Uncommenting it (and enabling Analytics Engine on the account) is the prerequisite for this item and for P2-4.

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

### [ ] NOT STARTED — P2-4. Establish SLO alerts and runbooks

> **Status.** Depends on P2-3: there is no metrics sink to alert on until the Analytics Engine binding is enabled.

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

### [ ] NOT STARTED — P2-5. Add regression, load, and failure-injection coverage

> **Status.** **Highest-value remaining item.** Everything shipped on 2026-08-05 rests on mechanism reasoning plus one confirmed live measurement (P1-2). None of it has been exercised under the traffic shape that caused the incident, and the repository has no automated coverage of the API admission path — its three test files are all in `apps/ingestion`. `scripts/verify-incident-fixes.ts` is a first step, not a substitute.

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

> **What actually happened.** The wave plan was not followed as written. Waves 1
> and 2 were largely collapsed into a single release on 2026-08-05 because the
> repository had no staging replay or feature-flag scaffolding to stage them
> behind, and because the CPU item (P0-3) that Wave 2 was built around turned
> out not to need doing. That release did combine the limiter migration and the
> retry-policy change, which the rollback rules below advise against — the
> mitigating factors were that each change is a separate revertible commit and
> the riskiest one is env-tunable without a redeploy.

- [-] Confirm the effective Worker CPU limit. *(Answered from the existing
      export rather than the dashboard: the account is on a paid plan, so the
      limit is 30 s. See P0-3.)*
- [ ] Add/verify Neon capacity alerts.
- [~] Capture current baselines for retry ratio, CPU outcomes, search latency,
      concurrency rejection latency, and Durable Object calls. *(Baselines for
      CPU, latency and DO calls were taken from the incident export and the
      pre-deploy tail; retry ratio and rejection latency were not.)*

This wave is operational/read-only except for alerts and documentation.

### Wave 1 — remove amplification

- [x] P0-1: retry policy. *(Server-side, `74906d2`.)*
- [ ] P0-2: singleflight/cancellation. *(Client-side; server half shipped.)*
- [x] P0-6: stable error taxonomy required by the client policy. *(`78eec89`.)*
- [~] P0-4: database circuit breaker. *(Classification only; breaker outstanding.)*

Deploy client retry and server error classification compatibly: older clients
must continue to receive valid status codes, while newer clients consume the
machine code. *(Satisfied — the new headers are additive and every response
keeps a valid status code, so unmodified clients are unaffected.)*

### Wave 2 — stabilize admission and CPU

- [-] P0-3: deploy the verified CPU setting with profiling. *(Dropped.)*
- [x] P0-5: early overload shedding. *(`65d0717`.)*
- [x] P1-1: idempotent leases. *(`55b6d4d`.)*
- [x] P1-2: limiter consolidation. *(`261742d`.)*

Roll out lease/admission changes behind a server feature flag or percentage
split, compare counts with the old limiter, then migrate fully. *(**Not
followed** — shipped at 100% in one release. No flag scaffolding existed, and
the DO limiter's state is in-memory and resets on deploy, so a percentage split
across two limiter topologies would have double-counted. The `RETRIEVAL_*` env
knobs are the substitute rollback path.)*

### Wave 3 — correctness

- [x] P1-3: query complexity. *(`5b9649e`, `7e5683b`.)*
- [ ] P1-4: deletion/ingestion coordination. *(Blocked on a design decision.)*
- [ ] P1-6 / [~] P1-7: dependency retry policy. *(Search side only.)*
- [ ] P1-8: usage-write race. *(Blocked on a policy decision.)*
- [x] P1-5: final timeout contract. *(`f2beb5c` — done first, not last, because
      it was the primary amplifier rather than a follow-up refinement.)*

### Wave 4 — provability and continuous validation

- [ ] P2-1: lifecycle correlation.
- [ ] P2-2 / P2-3: dashboards, metrics, and logging. *(Blocked: `ANALYTICS`
      binding is commented out, so metrics are no-ops in production.)*
- [ ] P2-4: SLO alerts/runbooks.
- [ ] P2-5: automated load and failure-injection suite.

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

The incident can be considered fully remediated when all of the following are
**measured true in production**. None are ticked yet: the mechanisms for several
are deployed, but nothing here has been observed under load. Ticking these is
the job of P2-5.

- [ ] automatic retry traffic stays below 5% during overload — *mechanism
      deployed (`x-should-retry` / `Retry-After`), unmeasured*
- [ ] duplicate logical recalls do not create duplicate searches — *needs P0-2;
      the server-side `leaseKey` is inert without a client recall id*
- [ ] CPU terminations are zero in incident replay and negligible in production
      — *expected to follow from the database and retry fixes, not from a CPU
      setting; unmeasured*
- [ ] Neon exhaustion fails fast as classified 503 without a retry storm —
      *mechanism deployed, not yet exercised against a real exhaustion*
- [ ] rejected searches avoid expensive dependency work — *deployed; rejection
      is 1 DO call by construction, unmeasured under load*
- [ ] concurrency slots are idempotent and self-reclaiming — *tokenized release
      and TTL reclaim deployed; idempotency needs P0-2*
- [ ] pathological queries degrade safely — *two defenses deployed, unmeasured*
- [ ] space deletion cannot create ingestion FK failures — *needs P1-4*
- [ ] client timeout behavior is documented and measured — *server deadline
      documented and changed; client-side measurement outstanding*
- [ ] scheduled transient failures recover within their bounded retry policy —
      *needs P1-6*
- [ ] a single event ID proves ingestion, triage, outbox enqueue, and delivery —
      *needs P2-1*
- [ ] dashboards distinguish public requests from internal/log events — *needs
      P2-2, which needs the Analytics Engine binding*
- [ ] all scenarios are covered by repeatable staging tests and runbooks —
      *needs P2-5 and P2-4*

