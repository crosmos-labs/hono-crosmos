# Crosmos Grafana dashboard

`crosmos-observability.json` is a portable classic dashboard model. Import it
through Grafana's dashboard UI and select an Infinity datasource when prompted.

Configure the datasource before importing:

- Plugin: `yesoreyeram-infinity-datasource`.
- Allowed host: `https://api.cloudflare.com`.
- Authentication header: `Authorization: Bearer <token>`, stored in the
  datasource's secure configuration. The token needs only Account Analytics
  Read.
- The dashboard uses backend JSONata parsing (`root_selector = data`) so the
  same queries can later be used by Grafana Alerting.
- The `cf_account_id` dashboard variable defaults to the non-secret Crosmos
  account ID. Do not commit an API token or put it in a panel query.

Every count uses `sum(_sample_interval)` and every percentile uses
`quantileExactWeighted`. The dashboard defaults to the last 24 hours because
Analytics Engine retention must be confirmed for the account before selecting
long comparison windows. Queries use Grafana's space-separated UTC timestamp
format because Analytics Engine rejects the `T`/`Z` ISO macro expansion inside
`toDateTime`. They also require `length(blob4) = 8` so rows emitted before the
O-1 deploy-version field was added cannot be misread using the current blob
layout.

The throttle panel intentionally uses two queries rather than a scalar
subquery or a conditional weighted quantile. Query A always returns attempts,
rejections, and share (including a healthy zero); query B returns reason and
weighted rejection p95 only when rejection events exist. This stays within the
Analytics Engine SQL subset and distinguishes "zero throttling" from a broken
panel.

The API latency-clock panel intentionally keeps three boundaries separate.
`request_total` begins before all application middleware, `http_request` begins
at the access-log middleware, and `search` begins only after search admission.
The panel uses two Analytics Engine queries because successful `search` points
do not carry a path tag; labeling that bounded metric as `/api/v1/search` in its
own query avoids positional-blob tricks and stays within the Analytics Engine
SQL subset.

The original seven-panel production import and raw-SQL parity check were
completed on 2026-08-14. The eighth latency-clock panel is committed locally
and still requires import/parity verification after `request_total` is deployed.
For the same moving 24-hour window, Grafana and the Cloudflare SQL API showed 16
search attempts, zero rejections, 301 HTTP requests, two errors, and matching
endpoint and stage percentiles. Before enabling alert rules, induce a staging
throttle burst and confirm it appears; also record the measured Analytics
Engine retention once the datasets are old enough to observe it.

## Production log and trace drill-down

Cloudflare's `grafana-logs` and `grafana-traces` OTLP destinations are attached
to the production API and ingestion Workers at 100% sampling. Cloudflare
persistence remains enabled at the same rate; Grafana export does not replace
Workers Logs or the R2 archive.

In Explore, select the Loki datasource and use:

```logql
{service_name=~"crosmos-(api|ingestion)-production"}
```

Use the exact service when narrowing one request:

```logql
{service_name="crosmos-api-production"}
```

For Tempo, select the traces datasource and search with this TraceQL filter, or
choose the same value in the Service Name field:

```traceql
{ resource.service.name = "crosmos-api-production" }
```

Open a trace, copy its trace ID, and filter the Loki result by the structured
`trace_id` field with that exact value. Do not use the old
`{exporter="OTLP"}` selector: native OTLP ingestion promotes the service name
and keeps trace IDs as structured metadata. API-to-ingestion queue work is not
one automatically parented distributed trace; follow that hop through the
bounded request, correlation, and job identifiers in structured logs.

The production rollout versions are API
`554c1bad-c200-4537-aedc-d4fc583c337c` and ingestion
`05e3c0d2-a4d4-4a05-97a1-f597fc1b88b3`. A visible trace or log with those
resource versions proves the result belongs to the production rollout rather
than the earlier staging verification.

## Trace and log dashboards

Three more dashboards live in the `Crosmos` folder of the stack and are
snapshotted here. They were created through the Grafana API, so the live copy is
authoritative; re-export after editing in the UI.

- `crosmos-retrieval-traces.json` (uid `crosmos-retrieval-traces`) — the search
  path, keyed off the `api_stage.search_total` span.
- `crosmos-ingestion-traces.json` (uid `crosmos-ingestion-traces`) — the
  pipeline, keyed off `ingestion.job_total` / `ingestion.source_total`.
- `crosmos-logs.json` (uid `crosmos-logs`) — Loki volume, HTTP outcomes, and the
  counters parsed out of the structured JSON lines.

They exist because Cloudflare names every root span after its trigger, so Tempo
search shows an undifferentiated list of `POST` / `GET` / `queue` / `jsrpc` and
gives no way to tell a retrieval trace from an ordinary request. Filter on the
Crosmos stage spans instead of the root: `api.request_total` wraps a request,
`api_stage.*` and `ingestion_stage.*` are the stages, and every stage span
carries `crosmos.stage` plus `crosmos.outcome`.

Each trace dashboard pairs a TraceQL search table with a `traces` panel bound to
a `trace_id` textbox variable, and the table's trace ID column links back to the
same dashboard with that variable set. Clicking a slow trace therefore renders
its per-stage waterfall in the page, with the matching Loki lines underneath, so
no Explore round trip is needed.

Three constraints shaped the panel definitions:

- TraceQL metric queries (`quantile_over_time`, `rate`, `count_over_time`) are
  rejected beyond a 25-hour range on this tier, so both trace dashboards default
  to 6h. Trace search tables have no such cap.
- Empty metric buckets return `0` rather than null, so `lastNotNull` reduces a
  quiet minute to `0 ms`. Stat tiles and bar gauges reduce with `max` or `mean`
  over the window instead.
- Quantiles come from an exponential histogram, so at current traffic they land
  on bucket boundaries (0.13s, 0.27s, 0.54s, 1.07s, 2.15s, 4.29s, 8.59s). Treat
  them as ranges; the log-derived `duration_ms` panels give exact values.

Bar gauges ignore their own `sortBy` option, so the ranked stage panels apply
`renameByRegex` + `reduce` + `sortBy` transformations to get one sorted row per
stage.

The log latency and error tiles are scoped to `/api/` paths. Unscoped, they are
dominated by internet scanners probing `/.git/config` and `/wp-includes` paths,
which all 404: over one six-hour sample that was 69 non-2xx responses unscoped
versus 9 real ones.

Grafana Cloud Application Observability's service list stays incomplete because
no span metrics are generated from these traces — `traces_spanmetrics_*`,
`traces_service_graph_*`, and `traces_target_info` are all absent from the
Prometheus datasource. Enabling metrics generation for the traces datasource in
the Cloud portal is what populates that view, the service map, and RED metrics;
it is not something the stack API can turn on.
