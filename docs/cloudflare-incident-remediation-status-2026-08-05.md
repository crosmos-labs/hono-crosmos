# Remediation status — Cloudflare incident, 25 July 2026

Companion to
[`cloudflare-incident-remediation-plan-2026-07-25.md`](./cloudflare-incident-remediation-plan-2026-07-25.md)
and
[`cloudflare-observability-incident-2026-07-25.md`](./cloudflare-observability-incident-2026-07-25.md).

Status as of 2026-08-05: the server-side P0 set plus the admission restructuring
is **implemented and committed, not yet deployed**. Nothing in this round
required a schema migration, a Cloudflare dashboard change, or an SDK release.

## Corrections to the original analysis

Two findings in the source documents are wrong or understated. Both change what
should be done, so they are recorded before the work.

### The Worker CPU limit is not the problem (P0-3 should not be actioned)

The analysis inferred an effective Free-plan 10 ms CPU limit from the fact that
CPU terminations clustered in the low tens of milliseconds, and P0-3 proposed
verifying and raising `limits.cpu_ms`.

The account's own telemetry refutes this. From the recovery window in
`logs-2026-07-25T21_49_19.708Z.json`:

| Trigger | n | CPU p50 | CPU max | Outcome |
|---|---:|---:|---:|---|
| `POST /api/v1/search` | 34 | 37 ms | 84 ms | 34/34 `ok` |

A 10 ms ceiling cannot pass a 37 ms median. Independently, the Worker uses
Hyperdrive, Queues, Smart Placement and SQLite-backed Durable Objects — all
Workers **Paid** features — so the effective limit is the paid default of 30 s.
Setting `limits.cpu_ms` would be a no-op.

The stronger signal is that CPU-*terminated* invocations averaged 12.5 ms CPU
(p99 36 ms) — materially **less** than the successful population's 70 ms p95.
Those requests were not compute-bound; they were stalled on I/O while the
database was refusing work. They are a symptom of the Neon exhaustion, not an
independent failure class, and they should disappear when the database
condition and the retry amplification are addressed.

**Recommendation:** drop P0-3. Do not change the CPU limit. Re-measure CPU
outcomes after this round deploys and only revisit if terminations persist
against a healthy database.

### Internal Durable Object traffic was undercounted

The analysis reported "at least 3.77 internal DO fetches per public search".
Counting invocation rows in the export gives a higher figure:

| Trigger | Invocations |
|---|---:|
| `POST /limit` | 170 |
| `POST /acquire` | 34 |
| `POST /release` | 35 |
| `POST /api/v1/search` | 34 |

That is **7.03 DO calls per search** — five of them rate-limit checks (mgmt rpm,
mgmt day, plan rpm, plan day, global AI). The export also shows those calls
reaching **300 ms wall time**, not the "single-digit ms" the code comments
assume, so they were a latency cost as well as a volume cost.

### The primary amplifier was the timeout mismatch, not CPU

The plan files the 3 s/30 s client/server timeout mismatch as P1-5, a
documentation item. It was the dominant structural cause.

`RETRIEVAL_RESULT_TIMEOUT_SECONDS` was 30 s while the client sends
`x-stainless-timeout: 3`. The server continued working — holding the caller's
concurrency slot — for up to 30 s on requests the caller had already abandoned.
With `RETRIEVAL_MAX_CONCURRENT_PER_USER = 10`, sustainable per-user throughput
was therefore `10 / 30s ≈ 0.33 req/s`, and everything above that rate received a
concurrency 429 regardless of backend health. That is the mechanism behind the
52.98% rejection share.

## What shipped

| Commit | Plan ID | Change |
|---|---|---|
| `74906d2` | P0-1 | `Retry-After` + `x-should-retry` on concurrency/quota rejections |
| `f2beb5c` | P1-5 | Retrieval deadline 30 s → 6 s; slot TTL derived as timeout + 4 s |
| `55b6d4d` | P1-1 | Tokenized concurrency leases; release frees your own slot |
| `65d0717` | P0-5 | Concurrency gate moved ahead of entitlements/space/plan/quota |
| `261742d` | P1-2 | 5 limiter round-trips per search → 1 |
| `5b9649e` | P1-3 | Auxiliary signals fail soft instead of failing the search |
| `7e5683b` | P1-3 | tsquery complexity bounded at both call sites |
| `78eec89` | P0-6 | Database capacity/connection failures classified as 503 |

### P0-1 — client retry policy, solved server-side

The plan assumed this required an SDK change. It does not. The Stainless client
checks a non-standard `x-should-retry` response header **before** any
status-code rule (`../crosmos-ts-sdk/src/client.ts`, `shouldRetry`) and obeys it
verbatim, and it honors `Retry-After`. Neither header was ever set, so the
default — retry 408/409/429/5xx — applied to everything.

The server can therefore shut off the retry storm against the **already-shipped**
client. This matters because Stainless is winding down and the SDKs have not been
migrated, so a server-side lever is the only one available today.

| Condition | Status | Header | Rationale |
|---|---:|---|---|
| Concurrency full | 429 | `Retry-After: 3` | The user's own work has not drained; immediate retry worsens it |
| Monthly quota | 429 | `x-should-retry: false` | No retry outwaits a monthly window |
| DB capacity exhausted | 503 | `x-should-retry: false` + `Retry-After` from the provider's stated renewal time | Deterministic until renewal |
| DB connection lost | 503 | `Retry-After: 60` | Transient; retry, but paced |
| Retrieval timeout | 504 | `Retry-After: 3` | Under load, immediate retry re-competes for the freed slot |
| Unexpected defect | 500 | `x-should-retry: false` | A second identical request is no likelier to succeed |

### Admission path, before and after

```
BEFORE                                   AFTER
authentication                           authentication
  mgmt rate limiter    (2 DO)              [skipped on /search]
  entitlements + space (2 KV)            concurrency acquire    (1 DO)  ← rejects here
  plan AI limiter      (2 DO)              entitlements + space (2 KV)
  monthly quota        (1 DB)              plan AI limiter      (1 DO)
  concurrency acquire  (1 DO)  ← rejects    monthly quota       (1 DB)
  global AI limiter    (1 DO)              global AI limiter    (1 DO)
  embed + retrieve                         embed + retrieve
```

Durable Object calls per search: **7 → 4** (acquire, plan limit, global AI,
release). Per *rejected* search: **6 → 1**, which meets the plan's
"fewer than two admission DO calls" criterion.

> Correction: commit `261742d`'s message states "7.03 → 3 DO calls per search".
> The correct figure is **4** — acquire, the combined plan limit, global AI, and
> release. The 5 → 1 limiter-call figure in that message is right.

Per-user throughput ceiling: **0.33 → 1.67 req/s** (10 slots / 6 s), with leaked
slots self-healing in 10 s instead of 30 s.

## Rollback levers

Every change is a separate commit and revertible independently. The highest-risk
change is also tunable **without a redeploy**:

```toml
RETRIEVAL_TIMEOUT_SECONDS = "30"   # restores pre-incident behavior; slot TTL follows
RETRIEVAL_SLOT_TTL_SECONDS = "34"  # floored at timeout + 4s grace; cannot be set unsafely
```

Two behaviors reset once on deploy, both benign:

- Rate-limit fixed windows move to new DO instance names, so counters reset. This
  is already documented behavior on DO eviction, and an early window reset only
  grants allowance — it cannot 429 anyone.
- Concurrency leases acquired by the previous version release via the retained
  tokenless path.

## Verification before deploy

No automated coverage exists for the API admission path — the repository has
three test files, all in `apps/ingestion`. The logic changed here was checked
against standalone harnesses (lease semantics, multi-window limiter, tsquery
bounding, dependency classification against the literal incident strings), and
the monorepo typechecks and builds clean. That is **not** a substitute for
staging validation. Before production:

1. Deploy to staging and confirm a normal search still returns identical
   candidates for a fixed query set (the signal fan-out and tsquery bounding are
   the two changes that could move ranking; both are designed to be no-ops on
   normal input, and that should be observed, not assumed).
2. Drive a per-user burst above the cap. Expect: 429 with `Retry-After: 3`, one
   DO call per rejection, no 500s.
3. Confirm `retrieval.request_completed.duration_ms` p50/p95 are unchanged —
   `t0` was deliberately kept measuring the retrieval phase only so this
   comparison stays valid.
4. Inject a `Usage limit for account exceeded` error and confirm a 503 with
   `x-should-retry: false`, not a 500.

## Not done

Deliberately out of scope this round; unchanged from the plan.

| Plan ID | Item | Why deferred |
|---|---|---|
| P0-3 | Worker CPU allowance | Premise refuted above — should be dropped, not deferred |
| P0-4 | Neon circuit breaker + capacity alerts | Classification (P0-6) already stops the retry amplification; the breaker adds shared state and is a larger change. Alerts are a dashboard task. |
| P0-2 | Client singleflight/debounce | Client-side. The server half (idempotent `leaseKey`) is implemented and inert until a client sends a stable recall id. |
| P1-4 | Space deletion vs. in-flight ingestion | 24 terminal FK failures; needs a deletion-barrier design decision |
| P1-6 | Bounded retries for cron DB failures | Isolated, self-healing today |
| P1-7 | AI/vector dependency degradation | Partly covered by fail-soft signals |
| P1-8 | `daily_usage` FK race | Needs a policy decision on whether usage survives parent deletion |
| P2-* | Correlation IDs, dashboards, alerts, load tests | Observability workstream |

The single highest-value remaining item is **P2-5 load testing**, because
nothing here has been exercised under the traffic shape that caused the
incident.
