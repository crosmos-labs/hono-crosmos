# Hono Backend — Issues & Fixes (benchmark hardening)

Running the local LongMemEval‑S benchmark against the hono backend (apps/api +
apps/ingestion) surfaced a series of backend bugs and fragilities. This branch
contains quick/expedient fixes to keep the benchmark moving; **the plan is to
abandon this branch and reimplement these fixes cleanly in a fresh branch.**
This doc captures each issue so they can be re‑done properly.

Scope: **hono backend only** (apps/api, apps/ingestion, packages/db). Benchmark
harness, Docker, and Qdrant‑server issues are out of scope here.

Legend — **Severity**: P0 (data loss / outage) · P1 (reliability) · P2 (ergonomics).
**Prod‑relevant?**: does it affect production, or is it local‑dev‑only?

---

## 1. Postgres connection pool exhaustion / leak under Workers I/O isolation ✅ DONE
**Severity: P0 · Prod‑relevant: yes**

**Symptom.** Under sustained ingestion, Postgres hit `sorry, too many clients
already`; connection count climbed unbounded (saw 140→448 active). A naive
"share one module‑level pool" fix then broke with Cloudflare's
`Cannot perform I/O on behalf of a different request`.

**Root cause.** Two compounding issues:
- `postgres-js` was created with `idle_timeout: 0` (never closes idle
  connections), so per‑request pools leaked connections.
- Cloudflare Workers forbid reusing an I/O object (a DB socket) created in one
  request inside another request's handler — so a single shared module‑level
  pool is illegal; pools must be per‑request (or per‑message in the consumer).

**Location.**
- `packages/db/src/index.ts` — `createDb()`
- `apps/api/src/db.ts` — `getDb()` (per‑request, cached on `executionCtx`)
- `apps/ingestion/src/db.ts` — `getDb()` (per‑message)

**Fix applied (this branch).** `createDb` now uses
`{ max: 2, idle_timeout: 4, max_lifetime: 1800, fetch_types: false }`; api caches
the pool on `executionCtx` (one per request), ingestion creates one per message.

**Clean‑branch recommendation.** Keep per‑request pools but standardize the pool
config in one place; consider a small `max` (1–2) since each isolate handles one
request. Document the I/O‑isolation constraint next to `getDb` so nobody
"optimizes" it back into a module‑level singleton. Confirm prod (Hyperdrive)
sizing — Hyperdrive pools server‑side, so client `max` should stay tiny.

**Resolution (clean fix).** `createDb` (`packages/db/src/index.ts`) is now the
single source of pool config: `max: 2` (default, overridable via
`CreateDbOptions.max`), `idle_timeout: 4`, `max_lifetime: 1800`,
`connect_timeout: 10`, `fetch_types: false`. The leak‑prone `idle_timeout: 0` is
gone; idle connections now close in 4s so recycled isolates don't pin slots, and
the effective‑connection‑count math (`max × concurrent isolates`) is documented
on `CreateDbOptions.max`. The Cloudflare I/O‑isolation constraint is documented
on both `createDb` and `apps/api/src/db.ts#getDb` (per‑request cache on
`executionCtx`) so it can't be "optimized" into a module singleton;
`apps/ingestion/src/db.ts` already documents the per‑message pattern. Typechecks
green.

---

## 2. Best‑effort dispatch + startup race → orphaned `pending` jobs ✅ DONE
**Severity: P0 · Prod‑relevant: partially (worse locally)**

**Symptom.** A burst of `POST /conversations` returned `202` but the jobs sat in
`pending` forever and never processed. Log showed
`Error: Worker "crosmos-ingestion" not found. Make sure it is running locally.`
for both the queue enqueue and the RPC kick.

**Root cause.** `apps/api/src/features/sources/routes.ts` (~L271–328) commits the
source + job rows, then does **best‑effort** dispatch: `queue.enqueue()` (durable
backstop) and `queue.kick()` (RPC fast path), each wrapped so failures only log.
The design relies on a **cron re‑drive sweep** to recover any job whose
enqueue+kick both failed. But:
- During the worker **startup window**, the api worker is ready a beat before the
  ingestion worker; both enqueue and kick fail with "Worker not found".
- The request still returns **202** (job row exists), so the caller believes it
  succeeded.
- **Locally, the cron never fires** (wrangler dev doesn't run scheduled events
  automatically), so the orphaned `pending` job is never recovered. Even in prod
  it can sit pending up to the cron interval (~15 min).

**Location.** `apps/api/src/features/sources/routes.ts` enqueue loop (L275–302);
the 202 return (L315–328). Producer‑side `kick`/`enqueue` in
`apps/api/src/integrations/queue/cloudflare.ts`.

**Fix applied (this branch).** None in code — worked around operationally by
waiting for **both** workers before driving load, and by clearing orphaned jobs.

**Clean‑branch recommendation.**
- If **both** enqueue and kick fail, do **not** return 202 — return 503 so the
  client retries, OR synchronously mark the job for immediate re‑drive.
- Add a **fast** re‑drive path (don't depend solely on a 15‑min cron): e.g. a
  short‑interval sweep, or have the consumer self‑heal by scanning for stale
  `pending` jobs on boot.
- Consider a readiness gate: api should treat the ingestion service binding as a
  dependency and 503 until it's reachable.

**Resolution (clean fix).** New shared dispatcher
`apps/api/src/features/sources/dispatch.ts` replaces the per‑route best‑effort
loops in both `POST /sources` and `POST /conversations`:
- `dispatchIngestionJobs()` dispatches all of a request's jobs **concurrently**
  (response latency ≈ one round‑trip regardless of job count), retries the
  durable `enqueue` once (it's the durability‑bearing call), then awaits the
  `kick` (the `ingest()` RPC returns as soon as the run is scheduled, so it's
  cheap to learn the outcome), and classifies each job `durable` / `fast_only` /
  `failed`.
- `assertDispatchedOrRollback()` enforces the contract: if **every** job both
  failed to enqueue AND failed to kick (the startup race), it **rolls back** the
  job + source rows and throws **503 + Retry‑After** — no more silent 202 over
  orphaned `pending` rows, and no duplicate rows when the client retries.
  Partial failures keep their rows (forward progress made) and are logged
  (`ingestion.dispatch_partial_failure` / `_degraded`) for the re‑drive sweep to
  recover. The fast/short‑interval re‑drive and crash self‑healing are handled
  in **#3**. Typechecks green.

---

## 3. Orphaned in‑flight jobs permanently occupy the pending cap & queue‑depth gate ✅ DONE
**Severity: P1 · Prod‑relevant: yes**

**Symptom.** After any ingestion‑worker restart, all new `POST /conversations`
returned `429` ("Too many pending jobs") or `503` ("queue full") even though
nothing was actually processing. The cap/gate was full of **dead** jobs.

**Root cause.** Both producer gates count jobs by **status only**, with no age
bound:
- Pending cap: `gates.ts` → `jobStore.countActive(userId)` →
  `SELECT count(*) WHERE user_id=? AND status IN ('pending','processing')`.
- Queue‑depth gate: `queueDepth()` → `countActiveIngestionJobs(db)` →
  `SELECT count(*) WHERE status IN ('pending','processing')` (global), gated at
  `MAX_QUEUE_DEPTH = 5000`.

When a worker dies mid‑job, those rows stay `processing` forever and are counted
indefinitely, so the gates wedge shut.

**Location.**
- `apps/api/src/features/sources/gates.ts` — `preflight()` gates 2 & 3
- `apps/api/src/integrations/job-store/pg.ts` — `countActive()`,
  `countActiveIngestionJobs()`
- `apps/api/src/features/sources/constants.ts` — `MAX_QUEUE_DEPTH`,
  `MAX_PENDING_JOBS_PER_USER`

**Fix applied (this branch).** None in code (was mid‑implementation) — worked
around by manually deleting stranded `pending`/`processing` rows after restarts
(`scripts/bench-resume.sh`).

**Resolution (clean fix).** Added a **staleness window** (`STALE_JOB_MINUTES = 10`,
aligned with the ingestion job lease) plus a **reaper**:
- `pg.ts` — both counts now use `activeWithinWindow()`: a job counts only while
  `pending` AND recently created, or `processing` AND recently heartbeated
  (`started_at` is re-stamped per source by the ingestion worker, so a healthy
  long job never looks stale). `countActive`, `countActiveIngestionJobs`, AND the
  authoritative `createWithActiveCap` INSERT…SELECT guard all apply it, so a
  crashed worker's dead rows drop out of the count and the gates **self-heal
  instantly** — no manual cleanup.
- `reapStaleIngestionJobs(db)` flips stale `processing`/`pending` rows to
  `failed` (CAS-guarded on the same predicate the lease/claim uses, so it can't
  race a re-claim). Wired into the existing 15-min cron via `reapStaleJobs(env)`
  in `index.ts` (`cron.jobs_reaped`). The sources of a reaped job are recovered
  independently by the re-drive sweep (fresh job); this only retires the dead
  bookkeeping row so `GET /jobs/:id` and the daily cleanup see reality.
Typechecks green.

**Original clean‑branch recommendation.** Add a **staleness window** to both counts: only
count jobs whose `started_at`/`created_at` is within the last N minutes (a
benchmark extraction finishes in <60s; anything `processing` >5 min is orphaned).
This makes the gates self‑heal after a crash without manual cleanup. Pair with a
reaper that transitions stale `processing` → `failed`/`pending` for re‑drive.

---

## 4. Vector‑store write failures are terminal within a job (no retry / circuit breaker) ✅ DONE
**Severity: P0 · Prod‑relevant: yes**

**Symptom.** When the vector store (Qdrant) was degraded and returned 500s, the
ingestion job failed at the vector‑upsert stage and was marked **terminally
failed** — the session's memories were silently lost. Across a degraded window
this produced corpora that were "ingested" but near‑empty (≈63% of sessions in
affected corpora lost). The benchmark's per‑corpus status read `failed`.

**Root cause.** A vector‑upsert 500 (`QdrantRequestError`,
`POST .../points 500 "Service internal error"`) propagates as `source_failed` →
job `failed`, with no in‑job retry/backoff for the vector op and no
circuit‑breaker to pause intake when the store is unhealthy. (Memory notes a
prior "Qdrant retryable" durability fix, but a *persistently* red store outlives
in‑job retries.)

**Location.** apps/ingestion extraction pipeline (vector‑upsert stage) +
`packages/vector` Qdrant adapter. (Same stage that logs
`event: 'ingestion.source_failed', error_name: 'QdrantRequestError'`.)

**Fix applied (this branch).** None in code — mitigated operationally (watchdog
auto‑restarts a red Qdrant; see scripts/qdrant-watchdog.sh) + reducing write
concurrency (see #5).

**Clean‑branch recommendation.**
- Retry vector upserts with bounded backoff; if still failing, **re‑queue the
  job** (transient) rather than marking it terminally failed.
- Add a vector‑store **health/circuit‑breaker**: when upserts are failing, stop
  claiming new jobs (apply backpressure) instead of burning through sessions and
  losing them.
- Make "partial source failure" explicit and recoverable (idempotent re‑ingest
  should backfill only the missing vectors).

**Resolution (clean fix).** Two layered defenses so a degraded store re‑queues
instead of dropping sessions:
- **Adapter‑level bounded write retry** (`packages/vector/src/qdrant.ts`):
  `upsert`/`deleteByIds` now go through `writeWithRetry` — up to 3 attempts with
  exponential backoff + jitter on retryable status (429/5xx/timeout). Absorbs
  brief blips without re‑running the (expensive, LLM‑bearing) source pipeline;
  reads stay un‑retried (dedup read is non‑fatal, pipeline retry covers them).
- **Job‑level re‑queue on transient infra failure** (`process-ingestion.ts`):
  when a source exhausts its in‑source retry budget on a **retryable** error
  (`isRetryable` → vector/embedder/LLM 429‑5xx), it is no longer marked
  terminally `failed`. It's left `processing`, the job is reset to `pending`
  (`resetJobForRetry`), and `processIngestion` returns the new
  `retry_transient` outcome. The queue consumer re‑queues with a delay
  (`ingestion.job_transient_requeued`, `BACKSTOP_RETRY_DELAY_SECONDS`, bounded by
  `max_retries=15` → DLQ → cron re‑drive), and the RPC fast path logs + leans on
  the durable queue copy. On the re‑run, gate 2 skips completed sources, keeps
  permanent failures failed, and reprocesses the transient ones once the store
  recovers — so a degraded window no longer silently empties corpora. Combined
  with `purgeSourceArtifacts`, re‑ingest stays idempotent (no duplicate
  memories/vectors).

A standalone cross‑isolate **circuit breaker** (shared health state to stop
*claiming* during a known outage, saving LLM tokens) is intentionally deferred:
the re‑queue already removes the data‑loss P0, and the queue's retry backoff
provides the practical backpressure. Tracked as a follow‑up. Typechecks green
(all 8 packages).

---

## 5. Vector‑store corruption under load — ROOT CAUSE was Qdrant fd limit (infra), not the backend ✅ DONE
**Severity: P0 (data loss) · Prod‑relevant: yes (deployment config)**

**Symptom.** Under sustained ingestion the local Qdrant `crosmos-memories`
collection repeatedly went `red` / wedged / crash‑looped, 500ing every upsert
and silently losing memories. Initially mis‑attributed to write *concurrency*
(lowering `MAX_PENDING_JOBS_PER_USER` 25→8 only *delayed* it).

**Actual root cause (confirmed).** Qdrant hit the **open‑file limit**:
```
ERROR actix_server::accept: Error accepting connection: Too many open files (os error 24)
ERROR collection::update_handler: Failed to flush id_tracker mapping ...
```
The container's default `nofile` (~1024) is far too low; Qdrant accumulates
segment + WAL file handles under load, hits the cap, then can't open files to
flush → collection corrupts. Lower concurrency just slowed the fd accumulation.
**This is a Docker/Qdrant deployment‑config issue, NOT hono backend code.**

**Fix applied (this branch).** Raised the limit in `docker-compose.yml`
(qdrant service): `ulimits: nofile: { soft: 65536, hard: 65536 }` (Qdrant's
recommended minimum). Verified `cat /proc/1/limits` → 65536. Ran clean under
sustained load afterward. (`MAX_PENDING_JOBS_PER_USER=8` was kept as a safety
margin but is no longer the load‑bearing fix.)

**Clean‑branch note.** This belongs in infra/ops config, not backend code — the
compose change carries it. The *backend* angle that remains is **#4** (a degraded
store should backpressure/retry, not silently drop sessions). An explicit
vector‑write concurrency limit / batching in the worker is still nice‑to‑have but
was **not** the cause here.

**Resolution (clean fix).** The Qdrant service was **missing entirely** from
`docker-compose.yml` (the scripts referenced `docker compose ... qdrant` but it
was never committed — the fd fix had only ever been applied to an ad‑hoc
container). Added a proper `qdrant` service: pinned `qdrant/qdrant:v1.12.4`,
container `crosmos-dev-qdrant` (matches `scripts/qdrant-watchdog.sh`), ports
6333/6334, api‑key `local-dev-key` (matches `scripts/bench-setup.sh`), a named
`crosmos_qdrant` volume, and the load‑bearing **`ulimits: nofile {soft, hard:
65536}`** with a comment explaining it's the fd‑exhaustion fix, not a tuning
knob. `docker compose config` validates. The backend‑side resilience (#4) is
done, so a future fd blip degrades gracefully (retry + re‑queue) instead of
losing sessions.

---

## 6. Operational limits hardcoded (not env‑tunable) ✅ DONE
**Severity: P2 · Prod‑relevant: yes (ops flexibility)**

**Symptom.** Couldn't tune the benchmark without code edits — the per‑user cap,
queue‑depth cap, and retrieval ceilings were compile‑time constants.

**Root cause.** Constants with no env override:
`MAX_PENDING_JOBS_PER_USER` (=5000), `MAX_QUEUE_DEPTH` (=5000),
`RETRIEVAL_MAX_CONCURRENT_PER_USER`, `GLOBAL_AI_RPM_CEILING`.

**Location.** `apps/api/src/features/sources/{constants.ts,gates.ts}`,
`apps/api/src/features/search/*`, wired through `apps/api/src/bindings.ts`.

**Fix applied (this branch).** Made env‑overridable:
`MAX_PENDING_JOBS_PER_USER`, `RETRIEVAL_MAX_CONCURRENT_PER_USER`,
`GLOBAL_AI_RPM_CEILING` (read in routes/gates, fall back to constants).
`MAX_QUEUE_DEPTH` is **still hardcoded**.

**Clean‑branch recommendation.** Standardize a typed config layer that reads all
operational limits from env with sane defaults; include `MAX_QUEUE_DEPTH`. Keep
the constants as defaults only.

**Resolution (clean fix).** New single typed config layer
`apps/api/src/lib/limits.ts`: `getOperationalLimits(env)` returns
`OperationalLimits` — `maxPendingJobsPerUser`, `maxQueueDepth` (the previously
hardcoded gap), `staleJobMinutes` (from #3), `retrievalMaxConcurrentPerUser`,
`globalAiRpmCeiling` — each parsed via a defensive `envInt` (blank/invalid/<min
falls back to the compile-time constant, so a deploy typo can't silently disable
a gate). The constants remain as the **defaults only**. All request paths now
resolve through it: `preflight` takes a `limits` arg (gates 2 & 3),
`createWithActiveCap`/`getJobStore` take the cap + stale window,
`CloudflareQueueService.queueDepth` takes the stale window, and `/search` reads
the concurrency + global-AI ceilings. The env vars are declared in
`bindings.ts` and documented (commented, with defaults) in both `[vars]` blocks
of `apps/api/wrangler.toml`. `constants.ts` header updated to point readers at
the config layer. Typechecks green (all 8 packages).

---

## 7. `queueDepth()` is a Postgres COUNT, not the real queue depth ✅ DONE
**Severity: P2 · Prod‑relevant: yes (correctness of the gate)**

**Symptom.** The "queue full" 503 fired based on a Postgres row count, not the
actual Cloudflare Queue backlog — so orphaned `pending`/`processing` rows (see
#2/#3) tripped a *503 about the queue* that had nothing to do with queue health.

**Root cause.** `queueDepth()` →
`countActiveIngestionJobs(db) = COUNT(*) WHERE status IN ('pending','processing')`.
Cloudflare Queues expose no native depth, so this proxies it with a DB count —
but that count is polluted by stale jobs and conflates "in‑flight work" with
"queue backlog".

**Location.** `apps/api/src/integrations/queue/cloudflare.ts` (`queueDepth`),
`apps/api/src/integrations/job-store/pg.ts` (`countActiveIngestionJobs`),
gate in `apps/api/src/features/sources/gates.ts`.

**Clean‑branch recommendation.** Rename to reflect what it measures
(e.g. `inFlightJobCount`), apply the staleness window from #3, and reconsider
whether a global in‑flight count is the right admission signal vs. per‑org/per‑user.

**Resolution (clean fix).** Renamed `QueueService.queueDepth` →
`inFlightJobCount` across the port, the Cloudflare adapter, and the gate caller,
with docs that state plainly it's a DB-count proxy (Queues expose no native
depth), not the queue backlog. The staleness window from #3/#6 is already
applied to the underlying `countActiveIngestionJobs`, so stale rows no longer
inflate it. On the admission-signal question: the gate comment now frames the
global count as a **coarse account-wide safety valve**, with the **per-user
pending cap (gate 3)** as the primary admission control — so per-tenant fairness
comes from gate 3 and the global gate only trips on genuine aggregate overload.
A per-org signal is left as a future refinement (noted, not built). Typechecks
green.

---

## Known prior backend items (context, not from this session)
- **Ingestion LLM fetch had no timeout** → untimed fetch wedged isolates; fixed
  earlier (AbortSignal 60s/30s, commit 363b2cc). **Vectorize ops still untimed**
  (follow‑up).
- **TS ingestion has no text chunking** — each source stored as one chunk vs.
  Python's parent/recursive chunking; retrieval‑quality divergence.
- **Retrieval working‑set load** — `SELECT *` in candidates load pulls unused
  1024‑d embedding columns per query (O(N) per query); #1 scaling risk.

---

## Reliability hardening session (ingestion pipeline #1–#8)

End-to-end ingestion reliability pass (`bench-fixes`). All fixed unless noted.

**#1 — Lease double-claim on long sources (P0, prod).** The lease heartbeat only
beat *between* sources, so one long multi-chunk source could exceed `JOB_LEASE_MS`
while healthy and get re-claimed + processed concurrently → data corruption.
Fixed: throttled **per-chunk heartbeat** (`process-ingestion.ts` →
`ingestSource` `heartbeat()`), re-stamping `started_at` mid-source.

**#2 — Job-wide subrequest cap vs per-source guard (P1, prod).** Per-invocation
1000-subrequest cap is job-wide but the only guard was a per-source warn. Fixed:
`MAX_CHUNKS_PER_INVOCATION` budget + `MAX_CHUNKS_PER_SOURCE` hard cap;
over-budget sources defer via new `requeue_incomplete` outcome; oversized single
source fails terminally (`SourceTooLargeError`).

**#3 — Embedding-dimension drift (P1).** Validation now derives from
`embedder.dimensions` (single source of truth), not a hardcoded `1536`. pg-column
constraint documented. Prod = Qdrant + OpenAI te3 @1536.

**#4 — Vectorize write failure dropped memories (P1).** New port-level
`VectorStoreError { retryable }`; Qdrant extends it, Vectorize wraps binding
errors in it; consumer branches on the port type → re-queue, not silent drop.

**#5 — Orphaned-vector leak on purge (P2).** `purgeSourceArtifacts` now deletes
index vectors **before** PG rows (idempotent delete + chunk_memories survives for
id re-derivation on retry).

**#6 — Orphan windows only the cron recovered (P1).** `/conversations` now uses
the atomic `createWithActiveCap` (was a TOCTOU race). Both ingest routes wrap
post-INSERT work in a rollback guard (job-create/dispatch exceptions no longer
orphan `pending` sources). Re-drive sweep now marks no-owner
(`owner_deleted`) and budget-exhausted (`redrive_exhausted`) sources terminally
instead of silent limbo. Local-dev cron trigger documented in `operations.md`.

**#7 — Unbounded extraction / coarse text path (P1/P2).** Text/markdown now run
through a recursive character splitter (`chunking/text.ts`, ~2k-char chunks)
instead of one unbounded chunk — bounds extraction output and the dedup-hint
embed. `max_tokens` added to extraction + `finish_reason=length` truncation
surfaced as a clear error. Full `chonkie` (heading-aware) port still pending.

**#8 — Correctness edges.** Terse-fact drop relaxed (`MIN_FACT_WORDS=3`, keeps
"User likes ramen"). Cross-chunk dedup via a source-level `seen` set. Graph
join hardened against out-of-range/duplicate indices. `referenceTime` no longer
falls back to ingestion wall-clock (null when no `meta.date` → no fabricated
event_times on backfill); `recordedAt` is the learned-at timestamp.

**Deferred — `serial`/int4 ids as vector point ids (long-horizon).** All ingest
tables use `serial` (int4, max ~2.1B) and these ids double as Qdrant/Vectorize
point ids. A `bigserial` migration is a table-rewrite over PKs + FKs + point-id
mapping — heavy and risky, years away at current scale. Tracked here; not done.

---

_Last updated while running the local LongMemEval‑S benchmark. Append new
backend findings here as they surface._
