# Measuring a production change

Use this procedure for every latency item in Track P. A faster local request is
useful evidence, but it is not a production result.

## Before deployment

1. Write down the behavior/quality invariant and the one metric expected to
   move. Do not choose the success criterion after seeing the result.
2. Capture the current eight-character Worker version from `blob4` and confirm
   that the cohort has at least 100 comparable requests per endpoint. Use more
   for a noisy p99.
3. Record traffic mix, error rate, throttle share, and the relevant stage p95.
   A latency comparison with materially different paths, status mix, or load is
   not an attributable result.
4. Run the relevant equivalence, isolation, and retry tests before deploying.

## Deploy and compare

Ship one optimization per version or canary where practical. Wait for at least
100 representative requests in both cohorts, then run:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=... # Account Analytics Read only
bun scripts/compare-versions.ts \
  --before-version abcdef12 \
  --after-version 3456789a \
  --min-samples 100
```

For a canary or an operational event without clean deploy boundaries, compare
explicit non-overlapping UTC windows:

```bash
bun scripts/compare-versions.ts \
  --before 2026-08-14T10:00:00Z,2026-08-14T11:00:00Z \
  --after 2026-08-14T11:15:00Z,2026-08-14T12:15:00Z
```

The script refuses to print endpoint percentiles below the minimum sample size.
It uses sampling-weighted counts and percentiles and prints endpoint p50/p95/p99,
error-rate movement, throttle share, and stage-p95 deltas.

## Record the result

Paste this block into the corresponding Track P item or its linked result file:

```text
Change:
Before version/window:
After version/window:
Samples (before/after):
Endpoint p50 / p95 / p99 delta:
Relevant stage p95 delta:
Error rate (before/after):
Throttle share (before/after):
Behavior/quality gate:
Decision: keep / roll back / gather more data
```

A deploy containing two unrelated latency changes can establish that the bundle
moved, but cannot attribute the delta to either change. Traffic-mix shifts,
provider incidents, warm-cache effects, or too few tail samples mean “gather
more data,” not “no regression.” Roll back if the predeclared invariant fails,
even when latency improves.
