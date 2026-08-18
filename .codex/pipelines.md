# Pipelines

status: current
owner: engineering
last_verified: 2026-08-19
owns: current ingestion and retrieval execution sequence
does_not_own: provider credentials, tuning roadmap, or historical incidents

## Source and conversation ingestion

`POST /api/v1/sources` and `POST /api/v1/conversations` authenticate, resolve
the organization, apply plan/queue/pending-job/space/quota gates, persist source
and job state, enqueue a durable queue message, and request a low-latency service
binding kick. Conversation ingestion stores one conversation source; role-aware
windowing and lookback context are produced by the ingestion chunker.

The queue copy and RPC kick carry the same job identity. `claimJob()` is the
coordination point: exactly one delivery owns a live processing lease. The queue
remains the durable recovery path if the RPC call never starts or dies.

## Job and source processing

`processIngestionRun()` owns job claim/heartbeat, source iteration, checkpoint
continuation, retry classification, job rollup, and usage accounting.
`ingestSource()` owns one source pipeline:

1. Load the source and create deterministic chunks.
2. Resume from the durable chunk checkpoint and plan the bounded window.
3. Build batched existing-memory hints for deduplication.
4. Extract and normalize atomic memories; resolve temporal context.
5. Extract graph entities/relations. Graph failure is non-fatal to memory
   extraction where the contract permits it.
6. Embed, persist canonical memories/evidence links, and write derived vectors.
7. Resolve entities and persist memory/entity and edge relationships.
8. Advance the checkpoint only after the window's durable work succeeds.

Healthy forward progress that exhausts an invocation budget publishes a fresh
continuation. Transient failures use the delivery retry budget. Terminal and
cancelled jobs cannot be reclaimed. The DLQ consumer records exhausted delivery;
scheduled recovery is responsible for durable redrive.

## Retrieval

`POST /api/v1/search` performs this sequence:

1. Authenticate, resolve entitlements once, authorize the space, and check plan
   and usage admission.
2. Acquire a per-user logical concurrency lease from `RateLimiterDO`; use the KV
   limiter only as the configured fallback.
3. Create one query embedding and run semantic, keyword, graph, and temporal
   retrieval signals with caller cancellation and a six-second route deadline.
4. Fuse signal ranks with reciprocal rank fusion and hydrate authoritative,
   visibility-scoped candidate data from Postgres.
5. Rerank with ZeroEntropy `zerank-2` when enabled; retained Voyage adapters are
   inactive until an explicit quality-approved migration.
6. Apply the existing relevance floor, temporal/recency/persistence scoring, and
   optional diversity selection without changing their ordering.
7. Load raw source content only for final selected candidates, map the response,
   and schedule touches/usage accounting as background work.
8. Release the concurrency lease in `finally`.

Qdrant supplies candidate IDs, not authorization decisions. Postgres visibility
and tenant scope remain mandatory during hydration. Ranking constants and stage
order are product behavior and must not change during structural refactors.
