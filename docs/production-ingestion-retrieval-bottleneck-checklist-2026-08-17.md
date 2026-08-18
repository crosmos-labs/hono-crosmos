# Production Ingestion and Retrieval Bottleneck Checklist

_Production measurement and architecture review, 2026-08-16 through 2026-08-17._

> **Retrieval sections superseded** by
> [retrieval-latency-budget-2026-08-17.md](./retrieval-latency-budget-2026-08-17.md).
> Re-measurement against the real corpus found this document's retrieval numbers
> were taken on a 22-memory synthetic space during a warm burst: actual
> `search_total` is p50 683–846 ms and **p95 3.30 s**, not p50 613 ms / p95
> 1.03 s. Three of its conclusions are refuted — reranker latency is flat in
> candidate count (so cutting candidates saves nothing), placement to
> `aws:us-east-1` is confirmed working (so regional measurement is not an open
> question), and the P0 ordering is a reliability/quality backlog rather than a
> latency one. The **ingestion** sections and the admission-isolation and
> abstention items remain valid and are carried forward in the new document.

## Purpose

This document records the production ingestion and retrieval measurements taken
after production stabilized, identifies the current critical paths, and turns
the findings into an ordered optimization backlog. It is an evidence record and
planning checklist only; no implementation or configuration changes were made
as part of the measurement run.

Related documents:

- [Observability, admin, analytics, and latency checklist](./observability-admin-analytics-checklist-2026-08-12.md)
- [Latency optimization opportunity audit](./latency-optimization-opportunity-audit-2026-08-11.md)
- [Ingestion and retrieval system design](./ingestion-retrieval-system-design.md)
- [Measuring a change](./measuring-a-change.md)

## Test scope

- A controlled production space was created with ID
  `01a00b32-8ddc-70ca-b2f3-16f8255d2092`.
- Seventeen accepted conversations completed ingestion and produced 22
  memories. Seven additional submissions were rejected by the plan rate limit.
- After the rate-limit window recovered, 20 retrieval variants completed
  successfully across the controlled corpus and the existing production
  corpus.
- An immediate 54-request retrieval burst was entirely rate-limited after the
  ingestion burst. This is evidence of workload starvation, not retrieval
  execution latency.
- Retrieval variants covered default behavior, temporal queries,
  diversification, graph-disabled and rerank-disabled experiments, source
  suppression, result limits, false-premise queries, and existing memories.
- Loki logs and Tempo traces were allowed time to surface before analysis.
- Percentiles are directional because this was a bounded diagnostic run, not a
  capacity test.

The controlled space remains in production so the run can be reproduced. Its
content is synthetic test data.

## Measured baseline

### End-to-end results

| Path | Samples | p50 | p95 | Notes |
|---|---:|---:|---:|---|
| Ingestion job, accepted to completed | 17 | 3.293 s | 5.529 s | All accepted jobs completed; no failures |
| Retrieval API request-ready clock | 20 | 680 ms | 1.403 s | Includes authentication, admission, and search |
| Retrieval core clock | 20 | 613 ms | 1.030 s | Search execution after admission |
| Retrieval observed by the client in India | 20 | 1.119 s | 2.062 s | Includes edge and network overhead |

The difference between client and server clocks was approximately 439 ms at
p50 and 659 ms at p95 for this India-based run. Validate from additional regions
before treating this as a global distribution.

### Retrieval stages

| Stage | Samples | p50 | p95 | Critical-path interpretation |
|---|---:|---:|---:|---|
| Search total | 20 | 643 ms | 1.063 s | Includes the stages below |
| Rerank | 18 | 318 ms | 438 ms | Largest serial retrieval stage |
| Graph signal | 20 | 249 ms | 574 ms | Runs concurrently with semantic search |
| Semantic signal | 20 | 186 ms | 508 ms | Runs concurrently with graph search |
| Query embedding | 20 | 151 ms | 361 ms | Shared dependency of semantic/graph work |
| Space access | 20 | 3 ms | 148 ms | Cold-cache tail, not steady-state median |
| Plan rate limit | 20 | 8 ms | 79 ms | Cold-cache tail plus admission work |
| Memory ANN batch | 20 | 15 ms | 68 ms | Not a leading bottleneck |
| Score and select | 20 | 0 ms | 29 ms | In-memory work is negligible |
| Source/provenance attachment | 20 | 13 ms | 20 ms | Low-value optimization target |

Graph and semantic durations must not be added together because they overlap.
The typical critical path is admission, the slower of graph or semantic work,
serial reranking, and final enrichment. Tempo confirms that wall time is
dominated by external AI/provider I/O rather than JavaScript CPU.

### Ingestion stages

| Stage | Samples | p50 | p95 | Critical-path interpretation |
|---|---:|---:|---:|---|
| Graph extraction | 17 | 1.506 s | 2.268 s | Largest ingestion stage |
| Memory extraction | 17 | 1.017 s | 1.408 s | Sequential predecessor of graph extraction |
| Entity resolution | 17 | 253 ms | 346 ms | Material but secondary |
| Entity embedding | 17 | 203 ms | 290 ms | External embedding I/O |
| Existing-memory hint embedding | 17 | 166 ms | 365 ms | Avoidable for provably empty spaces |
| Memory embedding | 17 | 171 ms | 255 ms | Already overlaps graph extraction |
| Persistence | 17 | 55 ms | 70 ms | Not a leading bottleneck |
| Usage rollup | 17 | 57 ms | 67 ms | Not a leading bottleneck |

Memory extraction and graph extraction are separate sequential chat-completion
calls. Memory embedding already overlaps graph extraction. The median critical
path is therefore dominated by the two extraction calls, followed by entity
resolution. Tempo showed approximately 34 ms of CPU time against 2.855 seconds
of wall time in a representative ingestion trace.

### Ingestion submission and durable backstop

| Stage | Samples | p50 | p95 | Interpretation |
|---|---:|---:|---:|---|
| API enqueue total | 17 | 160 ms | 901 ms | Tail dominated by durable queue dispatch |
| Dispatch | 17 | 62 ms | 699 ms | Queue send is the main component |
| Preflight | 17 | 69 ms | 187 ms | Secondary |

The current dual-dispatch design has a valid reason: an RPC fast path reduces
normal startup latency while a durable Cloudflare Queue message preserves
recovery. Atomic job claims prevent both paths from processing the same job.
The queue backstop often arrives while RPC processing is already in flight,
records `skipped_in_flight`, and retries later. Consequently, the current
`queue_wait` measurement mixes actual startup delay with harmless backstop
delivery and cannot be used directly as the ingestion latency SLO.

## Quality observations

- Exact fact retrieval was generally correct.
- A multi-period question asking about March and June returned the June event
  but omitted the March event, while a broader summary query found both. This
  indicates an aggregation or temporal multi-range recall gap.
- False-premise queries returned unrelated, low-score candidates rather than an
  abstention or empty result.
- Globally disabling reranking is unsafe. One exact controlled-corpus query was
  still correct without reranking, but an existing-memory query produced
  materially irrelevant results.
- A single graph-disabled sample did not establish a latency improvement and is
  not evidence for removing graph retrieval.
- Omitting source content saved only approximately 10–20 ms.

## Architecture assessment

The present foundations are reasonable and should not be rebuilt blindly:

- query embedding starts early and overlaps visibility work;
- semantic, keyword, temporal, and graph signals run concurrently;
- semantic and graph ANN reads are batched;
- final source and owner reads run concurrently;
- provenance work overlaps reranking;
- memory embedding overlaps graph extraction;
- touch and usage work are off the retrieval critical path;
- Postgres remains authoritative for authentication and visibility, while
  Qdrant is used as a derived retrieval index; and
- the RPC fast path plus durable queue backstop has explicit durability value.

The leading problems are therefore workload isolation, serial remote AI calls,
retrieval correctness at weak confidence, and global network placement. They are
not JavaScript execution, SQL persistence, or basic vector-search speed.

## P0 — Do first

- [ ] **Separate retrieval and ingestion admission classes while retaining one
  organization-wide cost ceiling.**
  - Give interactive retrieval reserved capacity.
  - Allow ingestion to borrow unused retrieval capacity, but never consume the
    reserved headroom.
  - Charge weighted cost units instead of treating all AI operations equally.
  - Return and honor an accurate `Retry-After` value.
  - Acceptance gate: a maximum-rate ingestion batch cannot cause retrieval 429s
    while the organization remains under its total allowed cost.

- [ ] **Build a retrieval correctness suite before accepting latency changes.**
  - Include multi-period temporal questions, aggregation, exact facts,
    paraphrases, distractors, and false premises.
  - Measure recall, temporal completeness, precision, unsupported-answer rate,
    and calibrated no-result behavior.
  - Preserve a fixed evaluation corpus and query set for before/after runs.
  - Reject any optimization that wins latency by silently lowering quality.

- [ ] **Add calibrated abstention or a no-match path.**
  - Define score and evidence requirements by query class.
  - Do not send obviously weak, unrelated candidates through expensive
    reranking by default.
  - Tune thresholds on labeled production-like queries rather than the small
    diagnostic sample.
  - Acceptance gate: false-premise precision improves without suppressing
    legitimate low-frequency memories.

- [ ] **Shadow-test one-pass memory and graph extraction.**
  - Produce memories, temporal fields, entities, and relations in one structured
    model response.
  - Run the current two-call pipeline in parallel during evaluation and retain
    it as a fallback for malformed or incomplete output.
  - Compare fact completeness, entity/relation correctness, temporal accuracy,
    retries, token cost, and time-to-searchable.
  - Initial target: ingestion p95 below 3.5 seconds with no quality regression.

- [ ] **Decide whether graph enrichment must block searchability.**
  - Alternative to one-pass extraction: persist core memories first and enrich
    graph/entity data asynchronously.
  - Expose explicit states such as `core_ready` and `fully_enriched`.
  - Document search consistency during enrichment and preserve idempotent retry
    and reconciliation.
  - Choose this design if time-to-searchable is more important than immediate
    graph completeness; do not introduce both architectural changes at once.

- [ ] **Run a reranker provider and placement bakeoff.**
  - Compare the current hosted reranker with lower-latency or colocated options.
  - Evaluate latency, retrieval quality, failure rate, rate limits, cost, and
    regional behavior on the fixed correctness suite.
  - Test adaptive reranking only where a cheap confidence signal proves it is
    unnecessary.
  - Do not globally remove reranking; the production sample showed a concrete
    relevance regression when it was disabled.

- [ ] **Benchmark query-embedding alternatives separately.**
  - Measure provider and region combinations before changing models.
  - Treat an embedding-model change as a versioned migration with a new
    collection, backfill, dual-read comparison, and rollback path.
  - Optimize reranking first because it is a serial stage and does not require
    re-embedding the corpus.

## P1 — High-value follow-ups

- [ ] **Instrument real time-to-searchable.**
  - Record API acceptance, durable enqueue, RPC start, queue start, claim
    outcome, processing completion, persistence completion, and first successful
    retrieval.
  - Tag trigger type and claim outcome on every timing.
  - Separate `queue_delivery_age`, `rpc_start_delay`, and
    `time_to_searchable`; exclude `skipped_in_flight` and terminal checks from
    the processing queue-wait SLO.

- [ ] **Preserve the durable backstop but reduce redundant polling.**
  - Experiment with a short initial queue-delivery delay so normal RPC jobs can
    finish before the backstop claims them.
  - Measure worker invocations, database claims, retries, crash recovery time,
    and worst-case time-to-start.
  - Do not remove the backstop or acknowledge work before durable ownership is
    established.

- [ ] **Investigate the durable queue-send tail.**
  - Break dispatch into binding lookup, queue send, retry, and RPC kick timing.
  - If a low-latency `202 Accepted` is an explicit SLO, evaluate a transactional
    outbox plus reliable dispatcher.
  - Record the durability and operational tradeoff: returning before queue send
    is unsafe unless the database transaction itself leaves recoverable work.

- [ ] **Optimize cold admission/cache tails without weakening authorization.**
  - Report warm/cold hit rates for API-key principal, organization, space,
    entitlement, and rate-limit state.
  - Add explicit invalidation or versioning before extending TTLs for
    security-sensitive decisions.
  - Measure the p95 improvement independently from AI-provider variation.

- [ ] **Add exact query-embedding caching only after measuring reuse.**
  - Measure normalized exact-query repetition in a privacy-safe aggregate.
  - Key entries by a query digest, model/version, dimensions, normalization
    version, and appropriate tenant scope; never expose raw query text in keys.
  - Use a bounded TTL and invalidate by model/index epoch.
  - Do not implement this if production reuse is too low to repay complexity.

- [ ] **Measure and improve provider prompt-cache effectiveness.**
  - Keep stable extraction instructions before variable conversation content.
  - Record cached input tokens, total tokens, latency, and cost by model and
    prompt version.
  - Change prompt layout only through an attributable A/B run with extraction
    quality gates.

- [ ] **Skip existing-memory hint work for provably empty spaces.**
  - Use a race-safe memory count or index epoch, not an eventually consistent
    guess.
  - Preserve correctness for concurrent first ingestions and retry/replay.
  - Expected opportunity is approximately 166 ms median on genuinely empty
    spaces.

- [ ] **Measure regional latency from India, Europe, and US East.**
  - Use the same corpus, query set, pacing, and production version.
  - Separate DNS/TLS/edge, Worker, database/vector, and AI-provider time where
    trace boundaries allow it.
  - If global sub-second retrieval is a product requirement, design regional
    read/vector/inference placement. Moving only the Worker is insufficient
    while authoritative reads and inference remain remote.

- [ ] **Repeat the mixed-load test after admission separation.**
  - Test increasing ingestion and retrieval concurrency with realistic pacing.
  - Track p50/p95/p99 latency, 429s, provider throttling, queue depth, errors,
    cost, time-to-searchable, and retrieval quality.
  - Establish saturation and recovery behavior; the current bounded sample is
    diagnostic evidence, not a capacity ceiling.

- [ ] **Deploy each optimization with isolated version attribution.**
  - Use identical workloads and explicit API/ingestion versions before and after
    each change.
  - Define the metric, quality gate, rollback trigger, and observation window in
    advance.
  - Avoid bundling unrelated optimizations that make attribution impossible.

## P2 — Evidence-driven or conditional work

- [ ] **Evaluate intent-based graph-search gating.**
  - First label query classes that do and do not benefit from graph expansion.
  - Remember that graph and semantic search overlap; graph's full duration is
    not automatically removable from wall time.
  - Gate only when quality remains equivalent and provider/load savings are
    measurable.

- [ ] **Continue SQL and Qdrant index auditing only from query-plan evidence.**
  - Current ANN and persistence stages are generally tens of milliseconds.
  - Require a slow-query sample, execution plan, cardinality estimate, and
    measured before/after result for every proposed index.

- [ ] **Offer lightweight source/provenance behavior only when the endpoint
  contract allows it.**
  - The current opportunity is approximately 10–20 ms.
  - Keep full provenance as the default where citation, deletion, or audit
    behavior depends on it.

- [ ] **Revisit architecture only against a declared SLO.**
  - Regional data and inference placement is justified by a global latency SLO,
    not by the existence of network overhead alone.
  - A transactional outbox is justified by an API-acceptance SLO plus a durable
    recovery requirement.
  - Two-phase ingestion is justified by a time-to-searchable SLO that permits
    temporary graph incompleteness.

## Explicitly defer or reject

- [ ] Do not globally disable reranking.
- [ ] Do not globally disable graph retrieval from a single timing sample.
- [ ] Do not prioritize Rust, WASM, or JavaScript CPU rewrites; measured CPU is
  negligible relative to external I/O.
- [ ] Do not add speculative SQL indexes.
- [ ] Do not prioritize Qdrant quantization or smaller vectors without measured
  pressure and a retrieval-quality study.
- [ ] Do not change embedding dimensions in place; use versioned collections and
  a backfill plan.
- [ ] Do not remove the durable ingestion queue or weaken recovery semantics for
  a faster API response.
- [ ] Do not add graph and semantic stage durations when estimating the critical
  path because they execute concurrently.
- [ ] Do not claim an optimization from a single request or a bundled deploy.

## Completion criteria

This checklist is complete only when:

1. retrieval remains available during ingestion bursts within the organization
   cost envelope;
2. retrieval latency improvements pass the fixed correctness and abstention
   suite;
3. ingestion has a measured, version-attributed reduction in
   time-to-searchable;
4. queue and RPC telemetry distinguish real work from durable-backstop checks;
5. global latency decisions are backed by multi-region measurements; and
6. every accepted optimization has a documented rollback trigger and production
   observation window.
