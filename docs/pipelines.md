# Pipelines

## Source Ingestion

Route: `POST /api/v1/sources`

1. Authenticate with JWT or API key.
2. Resolve org/principal context.
3. Run preflight gates in this order: plan rate limit, queue depth, per-user pending-job cap, space access, monthly token quota.
4. Insert `sources` rows with `extraction_status = pending`.
5. Insert an `ingestion_jobs` row.
6. Enqueue one Cloudflare Queue message with integer `org_id`, `space_id`, `user_id`, and `source_ids`.
7. Return `202` with `job_id` and source UUIDs.

Backpressure constants:

- Queue depth cap: `5000`
- Retry-After when queue is full: `30s`
- Pending jobs per user: `5000`
- Sources per request: `1..100`
- Content length per source: `100000` chars

## Conversation Ingestion

Route: `POST /api/v1/conversations`

Conversation messages are segmented into groups of 4. Each segment becomes one text source. The previous 4 segments are attached as `meta.lookback_context` for pronoun resolution during extraction. The route then uses the same source/job/queue path as `POST /sources`.

## Queue Processing

Consumer: `apps/ingestion/src/index.ts`

- One queue message is one ingestion job.
- Terminal jobs are no-ops on redelivery.
- Non-pending sources are skipped to keep redelivery idempotent.
- Retryable LLM/embedding failures retry per source up to 3 attempts with 5s, 10s, 15s delays.
- Source failures are captured in the job result; one bad source does not requeue the entire job.
- Unhandled outer failures are not acked and Cloudflare Queues retries or DLQs.

## Single-Source Pipeline

Function: `ingestSource()` in `apps/ingestion/src/ingestion/pipeline.ts`

1. Load source and normalize content.
2. Build existing-memory dedup hints with a search-mode embedding lookup.
3. Extract atomic memories with the LLM.
4. Extract graph entities/relations with the LLM; graph extraction failure is non-fatal.
5. Normalize and dedupe facts.
6. Fill missing event times with temporal regex fallback.
7. Embed memory text in batch.
8. Insert memories and `source_memories`.
9. Resolve entities with embedding prefilter plus fuzzy matching.
10. Insert `memory_entities` and graph `edges`.

Critical ingestion constants live in `apps/ingestion/src/constants.ts`.

## Search / Retrieval

Route: `POST /api/v1/search`

1. Authenticate and resolve principal.
2. Fetch entitlements once and reuse them for rate-limit, quota, and retrieval feature flags.
3. Apply per-org plan rate limit.
4. Resolve and authorize the space. Missing and cross-tenant spaces both return 404.
5. Check monthly search-query quota.
6. Acquire per-user search concurrency slot from KV.
7. Load scoped retrieval candidates.
8. Run `retrieve()` inline with a 30s timeout.
9. Return ranked memory candidates and schedule `touchMemories()` plus usage metering with `waitUntil`.
10. Release the concurrency slot in `finally`.

Retrieval stages:

- Extract temporal range.
- Embed query once and share it across semantic/graph signals.
- Run semantic, keyword, graph, and temporal signals in parallel.
- Fuse signals with reciprocal rank fusion.
- Attach source text for candidate context.
- Rerank with ZeroEntropy when enabled and allowed; otherwise rank-remap RRF scores.
- Apply recency, persistence, and temporal boost.
- Optionally apply MMR diversity.

Critical retrieval constants live in `apps/api/src/features/search/constants.ts`.
