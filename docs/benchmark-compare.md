# API Comparison Benchmark

This repo includes a benchmark harness for comparing the legacy API at
`https://api.crosmos.dev` with the Hono/Workers API at `https://hono.crosmos.dev`.

Run it with API keys supplied as environment variables:

```sh
CROSMOS_API_TOKEN='...' \
CROSMOS_HONO_TOKEN='...' \
BENCH_SPACE_NAME='comparision' \
BENCH_ITERATIONS=5 \
BENCH_WARMUPS=2 \
BENCH_INGESTION_BATCHES=1 \
bun --filter @crosmos/api bench:compare
```

The script writes JSON, CSV, and HTML artifacts under `performace bench/` at
the repo root. `performace bench/index.html` is always the latest visual report.

## What It Measures

- Endpoint inventory from `/openapi.json`, including common, API-only, and Hono-only routes.
- Public edge/docs latency: `/health`, `/openapi.json`, `/docs`, OAuth metadata.
- Authenticated lightweight reads: user, API key validation/listing, orgs, spaces, sources.
- Ingestion enqueue latency for identical source fixtures.
- Ingestion completion wall time by polling `GET /api/v1/jobs/{job_id}`.
- Created source retrieval latency with `GET /api/v1/sources/{source_uuid}`.
- Retrieval latency and result drift for three search scenarios.
- Retrieval score drift by rank, including top-result content equality and score deltas.
- Cloudflare cache headers where present, including `cf-cache-status` and `cf-ray`.

## Fairness Rules

- Use the same client location, machine, script, payloads, and request order for both targets.
- Keep warmups separate from measured samples with `BENCH_WARMUPS`.
- Treat Neon cold start as its own test by running after inactivity; treat warm performance as a separate run.
- Do not cache-bust normal application routes unless the scenario is explicitly a cache-bust test.
- Keep Cloudflare cache effects visible by recording cache headers rather than disabling cache.
- Keep search request volume below the plan RPM limit. For deeper retrieval runs, lower
  `BENCH_ITERATIONS` or wait for the rate-limit window to reset.

## Useful Options

- `BENCH_SKIP_INGESTION=1`: latency-only run without creating sources.
- `BENCH_INCLUDE_CONVERSATION=1`: also benchmark conversation ingestion.
- `BENCH_POLL_INTERVAL_MS=3000`: job polling cadence.
- `BENCH_JOB_TIMEOUT_MS=600000`: max wait per ingestion job.
- `BENCH_SEARCH_SCENARIO_PAUSE_MS=65000`: wait between retrieval scenarios to avoid RPM limits.
- `BENCH_OUTPUT_DIR=...`: override artifact directory. Relative paths are resolved from the repo root.
