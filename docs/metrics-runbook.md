# Metrics runbook

_Created 2026-08-11 alongside enabling Analytics Engine (checklist items P1-B and
P2-4)._

This is the "what do I look at, and what does it mean" half of observability. It
exists because the 2026-07-25 incident was not hard to fix once understood — it
was hard to *understand*, because 4,616 provider-budget rejections all looked
like generic HTTP 500s and nothing distinguished overload from a code defect.

## Datasets

| Dataset | Written by | Environment |
|---|---|---|
| `crosmos_api` | API Worker | production |
| `crosmos_api_staging` | API Worker | staging |
| `crosmos_api_dev` | API Worker | local/dev |
| `crosmos_ingestion` | Ingestion Worker | production |
| `crosmos_ingestion_staging` | Ingestion Worker | staging |
| `crosmos_ingestion_dev` | Ingestion Worker | local/dev |

Datasets are created automatically on first write. There is no provisioning
command, no dashboard toggle, and no beta signup — the binding in
`wrangler.toml` is the whole setup.

## Querying

```bash
ACC=17ebc9e30a1d9007b3b215b83492a487
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: text/plain" \
  --data "SELECT blob3 AS metric, sum(_sample_interval) AS events FROM crosmos_api
          WHERE timestamp > NOW() - INTERVAL '1' HOUR GROUP BY metric"
```

`SHOW TABLES` lists datasets. Writing needs only the Worker binding; **querying**
needs a token with `Account Analytics Read` (the Wrangler OAuth token already
carries enough for this).

### ⚠ Always count with `sum(_sample_interval)`, never `count()`

Analytics Engine **samples**. Each stored row carries `_sample_interval`, the
number of real events it represents; `count()` returns *stored rows*, which is a
different and smaller number.

Measured on production 2026-08-11: two searches emitted eight `retrieval_signal`
points. `count()` reported **4**; `sum(_sample_interval)` reported **8**, because
those rows came back with `_sample_interval = 2`.

This matters more than it first looks. Sampling gets *more* aggressive as volume
rises, so `count()` understates worst exactly when you are investigating an
incident — the moment you are most likely to conclude "the error rate isn't that
high". Averages are unaffected (`avg(double1)` is fine); **any count, rate or
sum of occurrences must be weighted.**

```sql
-- WRONG: undercounts, and undercounts worse under load
SELECT blob4 AS reason, count() FROM crosmos_api WHERE blob3 = 'search_throttled' GROUP BY reason

-- RIGHT
SELECT blob4 AS reason, sum(_sample_interval) AS events
FROM crosmos_api WHERE blob3 = 'search_throttled' GROUP BY reason
```

### Column convention

Every metric this repo emits uses the same layout, set by
`createMetrics` in `@crosmos/observability`:

| Column | Meaning |
|---|---|
| `blob1` | service (`api` / `ingestion`) |
| `blob2` | environment |
| `blob3` | metric name |
| `blob4…` | the call site's `tags`, in the order documented there |
| `double1…` | the call site's `values`, in order |
| `index1` | sampling key — the metric name |

**Tags are bounded-cardinality by rule.** Request, user, org, space, source, job
and recall IDs go in structured logs only, never in a tag: Analytics Engine
samples by index and a high-cardinality dimension both distorts sampling and
explodes storage. If you need to trace one request, use the logs.

## Signals worth alerting on

### Overload

| Metric | Read it as |
|---|---|
| `search_throttled` tag=`concurrency` | Per-user shedding. Some is healthy; a sustained rise means clients are retrying rather than waiting. |
| `search_throttled` tag=`global_ai` | The shared AI throttle is the binding constraint, not any one user. |
| `http_request` where blob6=`429` | Total shed rate. |
| `retrieval_deadline` tag=`rerank`,`skipped` | Requests running out of the 6s budget *before* reranking. Rising = upstream stages are getting slower. |

During the incident, concurrency rejections were **52.98%** of all search
invocations. Treat a sustained double-digit share as the same failure shape.

### Dependency failure

| Metric | Read it as |
|---|---|
| `http_request` where blob6=`503` | Classified dependency failure. Cross-check the logs' `code`: `database_capacity_unavailable` is deterministic (provider budget exhausted until a stated time) and no retry will help; `database_temporarily_unavailable` is transient. |
| `ingestion_ai_error` | LLM/embedder errors, tagged with dependency + status + retryable. |
| `cron_sweep` tag=`failed`,`retry_budget_exhausted` | A sweep retried a transient DB error three times and still failed. |
| `cron_sweep` tag=`failed`,`not_retryable` | Deterministic failure — a real bug, or provider capacity. Investigate, do not retry. |

A 500 that is *not* a 503 is the interesting case: it means an unclassified
failure reached the top-level handler. Classification is deliberately
conservative so a genuine defect is never disguised as a dependency problem.

### Stuck ingestion

| Metric | Read it as |
|---|---|
| `ingestion_dead_lettered` | A job exhausted its delivery retry budget. **Any** occurrence deserves a look — after P0-C, healthy progress no longer consumes that budget, so this should now be rare and always means real failure. |
| `ingestion_continuation` tag=`refused`,`no_checkpoint_progress` | A source asked to continue while committing nothing. Runaway-loop signature. |
| `ingestion_continuation` tag=`refused`,`continuation_limit_reached` | 800 continuations. Either a pathological source or a progress bug. |
| `ingestion_continuation` tag=`published` | Normal for large sources. Watch `double1` (continuation count) rising while `double2` (chunks processed) stays flat — that is churn without progress. |
| `ingestion_source_repeatedly_stuck` | Sources the redrive sweep keeps re-attempting. |
| `ingestion_outcome` tag=`failed` / `partial` | Terminal job failures. |

### Deletion backlog (P1-A)

| Metric | Read it as |
|---|---|
| `space_finalized` | A tombstoned space was physically removed. `double3` is the tombstone's age in ms — a rising age means the finalizer is falling behind. |
| `space_finalize_failed` | Vector purge failed; the tombstone was intentionally left for the next sweep. Repeated failures for the same space mean Qdrant is rejecting the delete. |

**Note:** while `SPACE_FINALIZER_ENABLED` is unset, neither metric will ever
appear and tombstones accumulate silently. Check the tombstone count directly:

```sql
SELECT count(*) FROM memory_spaces WHERE deleted_at IS NOT NULL;
```

### Recall degradation

| Metric | Read it as |
|---|---|
| `retrieval_signal` tag=`<signal>`,`failed` | A ranking input was lost. Semantic is essential; keyword/graph/temporal fail soft, so a failure here silently narrows recall rather than erroring. |
| `retrieval_signal` `double1` (candidate count) | A signal returning consistently zero is indistinguishable from "nothing matched" in the response. Compare across signals. |
| `search` `double1` (result count) | A drop with unchanged traffic suggests a signal is degraded rather than the corpus changing. |

This is the class of problem that produces no errors at all: the API returns 200
with fewer, worse results. Metrics are the only way to see it before a user does.

## Observed baseline (production, 2026-08-11)

First real read, so treat these as shape rather than thresholds:

```
retrieval_signal   semantic  ok   avg candidates 50.0   <- at the candidate-pool cap
retrieval_signal   graph     ok   avg candidates 50.0   <- at the candidate-pool cap
retrieval_signal   keyword   ok   avg candidates  0.0
retrieval_signal   temporal  ok   avg candidates  0.0
```

Keyword and temporal at zero were **expected here** — the probe queries were
nonsense phrases with no lexical match and no date expression. That is the
subtlety of this metric: zero is normal for those two on many real queries, so
alert on a *change in rate* for a signal, not on any single zero. Semantic
sitting exactly at 50 means it is saturating `CANDIDATE_POOL`, which is the
expected shape and also why a semantic drop would be conspicuous.

## What this runbook does NOT cover

- **Alert configuration.** Thresholds and routing live in the Cloudflare
  dashboard / provider tooling, outside this repository.
- **Dashboards.** Same — build them from the queries above.
- **Recall quality.** No metric here measures whether results are *good*. That
  needs the gold-set evaluation described in checklist item P0-A.
