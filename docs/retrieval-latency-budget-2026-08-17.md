# Retrieval latency budget and optimization plan

_Measured 2026-08-16/17 from production Loki + Tempo, plus a fresh 27-request
paced probe against `api.crosmos.dev`._

## Why this doc exists

[production-ingestion-retrieval-bottleneck-checklist-2026-08-17.md](./production-ingestion-retrieval-bottleneck-checklist-2026-08-17.md)
measured the right system and drew mostly the wrong conclusions for the goal
that matters: **server-side retrieval at ~400–500 ms for a US caller.** It
ranked admission-class separation, abstention, and one-pass extraction as P0.
None of those move retrieval latency. Meanwhile the single stage that is
**48% of the request** got one bullet under "run a bakeoff."

This doc replaces its retrieval sections. Its ingestion sections are still
broadly right and are carried forward here with sharper numbers.

Related:
[ingestion-retrieval-system-design.md](./ingestion-retrieval-system-design.md) ·
[latency-optimization-opportunity-audit-2026-08-11.md](./latency-optimization-opportunity-audit-2026-08-11.md) ·
[measuring-a-change.md](./measuring-a-change.md) ·
[metrics-runbook.md](./metrics-runbook.md)

---

## Three questions answered up front

### 1. Is placement actually pinned to the US? — **Yes, and it is working.**

`apps/api/wrangler.toml` sets `[env.production.placement] mode = "targeted"`,
`region = "aws:us-east-1"`. The telemetry confirms execution really happens
there, and the model you described is exactly what happens: one hop
user→us-east-1, then every subrequest is US↔US, then one hop back.

The proof is not the `cloudflare_colo` label — **that label is the entry colo,
not the execution colo**, and reading it as execution location will send you
down a wrong path. Over 24h, searches entered at five colos:

| entry colo | searches | `memory_ann_batch` p50 (Qdrant, us-east-1) |
|---|---:|---:|
| IAD | 138 | 23.5 ms |
| SIN | 30 | 17 ms |
| MAA | 44 | 38.5 ms |
| AMS | 4 | 16 ms |
| MRS | 1 | 89 ms |

A Worker genuinely executing in Singapore cannot reach Qdrant in us-east-1 in
17 ms — the RTT floor alone is ~230 ms. The Qdrant timings being flat across
every entry colo is what proves the Worker is relocated to us-east-1 in all of
them. Placement is not a problem and should be taken off the list.

The corollary is the uncomfortable one: **there is no geography left to blame.**
The 683 ms is in-region work.

### 2. How do supermemory / mem0 get their numbers?

Mostly by measuring a smaller pipeline, and partly by real engineering. Both
matter, and it is worth being precise so we neither cargo-cult nor dismiss them.

- **Mem0's published p50 of 148 ms / p95 200 ms is search *without* a
  cross-encoder.** Their own docs list reranking as an opt-in feature that
  "raises latency." Our comparable stage — query embed (140 ms) + ANN (23 ms) =
  **163 ms** — is already at parity. We are not losing on vector search.
- **Supermemory publishes an explicit 500 ms budget**: 50 ms network/edge,
  80 ms orchestration, 120 ms primary vector search, **100 ms reranking and
  downstream**, 150 ms variance buffer. They put rerank at 50–150 ms.
- They credit a **custom vector graph engine with ontology-aware edges**, so
  graph relationships resolve inside the index rather than as a sequence of
  round trips to a separate store. That is the one genuine architectural
  advantage, and it is the thing we cannot buy — but we can approximate most of
  it in Postgres (see P0-2).
- They also cache hot memories in-process at <5 ms. A stateless Worker cannot
  hold that, which is a real and permanent structural tax we pay for the edge
  deployment.

Mapping us onto Supermemory's own budget:

| Stage | Their budget | Crosmos measured (us-east-1 p50) | Verdict |
|---|---:|---:|---|
| Network / edge | 50 ms | ~20 ms (US caller) | ahead |
| Orchestration (auth + gates) | 80 ms | ~54 ms | ahead |
| Primary vector search | 120 ms | 163 ms (embed 140 + ANN 23) | slightly over |
| Rerank + downstream | 100 ms | **478 ms** (rerank 330 + graph 109 + assembly 39) | **4.8× over** |
| **Total** | **350 ms** | **683 ms** | |

Every part of this system is competitive except one stage, and that stage is
almost twice the size of everything else combined.

### 3. What the previous doc got wrong

- **It measured a 22-memory synthetic space during a warm burst**, then
  reported p50 613 ms / p95 1.03 s as the retrieval baseline. Against the real
  corpus, `search_total` p50 is 683 ms and **p95 is 3.30 s**. The tail was
  understated by 3×.
- **It reported rerank at 318 ms as "the largest serial retrieval stage" and
  then buried it.** It is the largest stage by a factor of two and it is
  reducible.
- **It proposed cutting reranker candidate count.** Measured: rerank latency is
  flat in candidate count (see below). That optimization returns zero.
- **It kept treating placement as an open question** ("Measure regional latency
  from India, Europe, and US East"). It is settled.
- Its P0 list (admission classes, abstention, one-pass extraction, correctness
  suite) is a good *reliability and quality* backlog. It is not a latency
  backlog, and it was presented as one.

---

## Measured baseline

Source: Loki, `service_name="crosmos-api-production"`, structured
`retrieval.stage_completed` / `auth.stage_completed` events. Sample: 138
searches over 24h entering at IAD, plus a fresh 27-request paced probe. Numbers
are directional (n is small), but the *shape* is unambiguous and reproduces
across both samples.

### Retrieval stage table

| Stage | p50 | p95 | On critical path? |
|---|---:|---:|---|
| **`search_total`** | **846 ms** | **3296 ms** | — |
| `rerank` | 379 ms | 737 ms | yes, serial |
| `signal_graph` | 288 ms | 1298 ms | yes (max of fan-out) |
| `signal_semantic` | 216 ms | 1204 ms | overlapped by graph |
| `retrieval_query_embedding` | 171 ms | 861 ms | yes, blocks both signals |
| `memory_ann_batch` | 23.5 ms | 390 ms | inside semantic |
| `auth_total` | 36 ms | 521 ms | yes, serial |
| `auth_api_key_db_resolution` | 18.5 ms | 882 ms | only on cache miss |
| `concurrency_acquire` | 14 ms | 253 ms | yes, serial |
| `global_ai_throttle` | 14 ms | 233 ms | yes, serial |
| `plan_rate_limit` | 9 ms | 282 ms | yes (‖ quota) |
| `space_access` | 7.5 ms | 165 ms | yes (‖ entitlements) |
| `entitlements` | 5 ms | 133 ms | yes (‖ space) |
| `visibility_scope` | 10 ms | 16 ms | yes, serial |
| `signal_keyword` | 12 ms | 85 ms | overlapped |
| `source_provenance_attach` | 13 ms | 63 ms | overlapped by rerank |
| `owner_name_load` / `source_content_load` | 10 / 10 ms | 14 / 13 ms | yes, ‖ each other |
| fusion, scoring, serialize | 0 ms | 0 ms | negligible |

The fresh paced probe (n=27, same day, real corpus) reproduced this with
`search_total` p50 **683 ms**, rerank 330, graph 249, semantic 174, embed 140.
Client-observed from India was p50 ~1.3 s; the India network tax is ~600 ms and
is not addressable from the server.

### Critical path, p50, US caller

```
auth_total                                    36
concurrency_acquire (DO)                      14
entitlements ‖ space_access                    8
plan_rate_limit ‖ monthly_quota                9
global_ai_throttle (DO)                       14
visibility_scope (PG)                         10
                                            ────  admission ≈ 91 ms
query embedding (OpenAI)                     140  ─┐
graph signal own work (≈6 serial PG hops)    148  ─┘ fan-out = 288
rerank (ZeroEntropy)                         330
owner_name ‖ source_content                   13
                                            ────
                                          ≈ 722 ms   (measured 683–846)
```

### Finding: reranker latency is fixed cost, not inference cost

`avg(duration_ms)` for `stage="rerank"` grouped by `candidate_count`, 24h:

| candidates | 1 | 5 | 10 | 20 | 30 | 50 | 75 | 92 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| avg ms | 490 | 395 | 320 | 315 | 440 | 490 | 399 | 340 |

There is no trend. **Reranking one document costs the same as reranking
ninety.** The 330–380 ms is network + provider queueing, not model work.

Direct consequences, all of which kill plausible-sounding optimizations:

- Lowering `RERANKER_MAX_CANDIDATES` (currently 300, effectively capped at
  `CANDIDATE_POOL = 50`) saves nothing.
- Truncating document text in `formatDoc` saves nothing.
- Adaptive "skip rerank when confident" saves 330 ms *only on skipped queries*,
  and buys it with a quality risk. It is a worse trade than just moving the call.

The only thing that moves this number is **where and by whom the rerank is
executed.**

### Finding: the graph signal is 6 sequential Postgres round trips

`graphSearchWithStore` (`apps/api/src/features/search/signals/graph.ts`) issues,
in order:

1. `Promise.all([getEntitiesByNameTokens (PG), entity ANN (Qdrant), seedByMemory → getEntitiesForMemories (PG)])`
2. `getEntityIdsLinkedToVisibleMemories` (PG)
3. `getMemoriesForEntities` (PG)
4. `getEdgesForEntities` × `MAX_DEPTH = 2` (PG, one per hop)
5. `hydrateMemories` (PG)

That is ~6 serial Hyperdrive→Neon round trips. In-region each is ~20 ms, which
is exactly the ~148 ms of graph own-work measured. The traversal logic itself is
microseconds; **we are paying almost pure round-trip tax.**

This is the stage where Supermemory's "custom graph engine" actually beats us,
and it is the stage we can most cheaply close without buying a graph database.

### Finding: p95 is a cold-dependency problem, not a load problem

Every dependency's p95 is 5–20× its p50: embed 171→861, rerank 379→737, ANN
23→390, `auth_api_key_db_resolution` 18→882, DO calls 14→253. Production runs
~11 searches/hour. At that rate nearly every request lands on a fresh isolate
with no warm TLS session to OpenAI, ZeroEntropy, Qdrant, or Hyperdrive.

The retrieval critical path touches **seven distinct connection targets**:
OpenAI, Qdrant, ZeroEntropy, Hyperdrive/Neon, KV, and two Durable Objects. Each
is an independent handshake to amortize. This is the structural reason p95 is
3.3 s, and it will improve on its own as traffic grows — but it should not be
left to chance, because 3.3 s is what a trialling customer will actually feel.

`API_KEY_CACHE_TTL_SECONDS = 60` makes this worse on purpose: at current traffic
most keys miss the cache, and the miss path is an 882 ms p95 DB resolution. The
60 s value was chosen as a revocation-lag bound, but revocation *already*
actively invalidates the entry (`features/auth/routes.ts`), so the short TTL is
belt-and-braces paid for on every request.

### Ingestion baseline (carried forward)

| Stage | p50 |
|---|---:|
| `graph_extraction` (LLM) | 1210 ms |
| `memory_extraction` (LLM) | 1046 ms |
| `ingestion_job_claim` | 321 ms |
| `entity_resolution` | 248 ms |
| `entity_embedding` | 203 ms |
| `memory_embedding` | 194 ms |
| `existing_memory_embedding_batch` | 180 ms |
| `persist_window` | 61 ms |
| `ingestion_usage_rollup` | 60.5 ms |
| everything else | ≤ 36 ms |
| `queue_wait` | 5341 ms (mixes real wait with durable-backstop delivery — not an SLO) |

Two serial chat-completion calls are **2256 ms of a ~2.8–3.3 s pipeline (≈75%)**.
The previous doc's one-pass-extraction proposal is correct and stays P0 for
ingestion.

---

## P0 — do these; they are the whole 500 ms story

- [ ] **P0-1. Move the reranker off a third-party HTTP round trip.**
  This is 48% of the request and the only stage where we are wildly off a
  competitor's published budget. Expected saving: **200–280 ms.**
  - Run a bakeoff on the existing LongMemEval harness (`../benchmark`) across:
    ZeroEntropy `zerank-2` (incumbent), **Workers AI `@cf/baai/bge-reranker-base`**,
    Cohere `rerank-v3.5`, Voyage `rerank-2-lite`, Jina `jina-reranker-v2-base`.
  - **The Workers AI adapter is already written, exported, and bound in prod**
    (`packages/ai/src/reranker/workers-ai.ts`; `[env.production.ai]` binding).
    It is a one-variable switch (`RERANKER_PROVIDER=workers-ai`) and it runs
    in-colo, so it removes the round trip entirely rather than shortening it.
  - **Know why it was dropped before you re-adopt it.** Workers AI was moved off
    in favour of ZeroEntropy for two recorded reasons: `zerank-2` scored better,
    and the Workers AI account concurrency ceiling (~50) surfaced as 429/503
    under load. Both must be re-tested, not assumed. If quality holds but the
    ceiling does not, ship Workers AI as primary with an external reranker as
    the 429 fallback — the `Reranker` port already makes that a small change.
  - Gate: no regression on the fixed LongMemEval retrieval suite (hit@1, recall,
    and the per-category breakdown), measured with the reranker **on** in both
    arms. Latency is not accepted as a win without the quality run.
  - Do **not** ship "disable reranking," "rerank fewer candidates," or "truncate
    documents." The flat-latency table above proves the last two return nothing.

- [ ] **P0-2. Collapse the graph traversal into one Postgres round trip.**
  Expected saving: **~110 ms** (148 → ~35).
  - Rewrite `graphSearchWithStore`'s seed → 2-hop expansion → hydration as a
    single `WITH RECURSIVE` statement. Postgres already does bounded recursive
    traversal well; we are currently doing the recursion in JavaScript and
    paying a network round trip per hop.
  - This is the affordable substitute for a graph database. It buys most of the
    traversal locality Supermemory gets from their custom engine, at the cost of
    one hard SQL query and no new infrastructure.
  - Keep every existing bound and visibility rule *inside* the CTE:
    `GRAPH_MIN_CONFIDENCE`, `GRAPH_MAX_EDGES_PER_HOP = 200`,
    `GRAPH_MAX_SEED_ENTITIES = 10`, `GRAPH_MEMORY_BUDGET = 100`, the `as_of`
    filter, `graphEdgeVisibilityClause`, and the final `scopeMemories` gate.
    Visibility must remain enforced at hydration, not assumed from the traversal.
  - Gate: byte-identical candidate lists against the current implementation on a
    recorded corpus before it goes live. Ordering matters — the SQL
    `ORDER BY effective_time DESC, id DESC` is load-bearing.
  - Also fix the known unbounded read while you are in there: the seed-entity →
    memory fanout (`onSeedFanout` currently only logs it). A hub entity can drag
    in a whole space. Read the logged distribution first, then pick a bound.

- [ ] **P0-3. Start the query embedding before admission, not after it.**
  Expected saving: **~50–90 ms**, zero quality impact, small diff.
  - The embedding depends only on `body.query`. Today it starts at
    `routes.ts:484`, *after* concurrency, entitlements, space access, plan rate
    limit, quota, and the global AI throttle. The comment claims it overlaps
    "visibility + working-set DB round-trips" — but `visibility_scope` is 10 ms,
    so it currently overlaps essentially nothing.
  - Move the kick-off to immediately after the concurrency lease (keeping the
    overload shield first), and let all remaining gates run against it.
  - Cost of being wrong: an embedding call (~$0.00001) burned on requests that
    later fail authz. Bound it by only starting after `requirePrincipal`, or
    accept the cost — it is smaller than the 429-retry cost we already tolerate.
  - Do not remove any gate. This is pure reordering of when the clock starts.

- [ ] **P0-4. Establish the correctness suite as a gate, not as a project.**
  Carried over from the previous doc, but scoped down so it does not block P0-1
  to P0-3 for weeks.
  - We already have LongMemEval running against a local stack
    (`docs/benchmarking.md`, `scripts/bench-setup.sh`). Freeze one corpus + query
    set as the retrieval gate and wire it to run before/after each P0 change.
  - Add the two failure classes the production probe surfaced: multi-period
    temporal questions (a March-and-June query returned only June) and
    false-premise queries (returned unrelated low-score candidates rather than
    abstaining). Track them; do not block latency work on fixing them.

**P0 total: 683 ms → ~290–320 ms server-side.** That clears the 400–500 ms
target with margin, and none of it touches ranking behavior.

---

## P1 — the tail, which is what customers actually feel

p95 is 3.3 s. Fixing p50 alone will not make the product feel fast.

- [ ] **P1-1. Raise `API_KEY_CACHE_TTL_SECONDS` from 60 s to 300 s.**
  Revocation already actively invalidates the cache entry, so the short TTL is
  redundant defence bought at an 882 ms p95 on every miss. Confirm the
  invalidation path covers key deletion, key expiry, and org suspension before
  changing it; if any of those relies on the TTL, fix that path first.
  Expected: `auth_total` p95 521 ms → ~40 ms.

- [ ] **P1-2. Reduce the number of distinct connection targets on the critical
  path.** Seven independent TLS handshakes is the structural cause of the p95.
  P0-1 (in-colo reranker) removes one. P0-2 removes several Hyperdrive round
  trips but not the target. Consider whether the two Durable Object calls
  (`concurrency_acquire`, `global_ai_throttle`) can be one.

- [ ] **P1-3. Make `global_ai_throttle` non-blocking.** It is fail-open, adds
  14 ms p50 / 233 ms p95 serially, and gates nothing that is correctness
  critical. Start it concurrently with the embedding and check the result before
  the reranker call instead of before the embedder. Preserve the shed behavior;
  only move when it is observed.

- [ ] **P1-4. Send embeddings as base64, not JSON floats.**
  `openai-compat.ts` pins `encoding_format: 'float'`, so a 1536-dim response is
  ~35 KB of JSON to transfer and parse instead of ~8 KB. The values are
  identical. Small (10–30 ms), free, and it also helps ingestion's batch
  embeddings. Verify the decoded vector is bit-identical before shipping.

- [ ] **P1-5. Decide the embedding model question with the data we already
  have.** A prior benchmark measured Workers AI edge embeddings beating OpenAI
  `text-embedding-3-small` by ~314 ms from a non-US-placed worker. From
  us-east-1 the gap is smaller (140 ms → maybe 30–40 ms), but it is real. This
  is a **versioned migration**, not a config change: new collection, backfill,
  dual-read comparison, rollback path, and a dimension change (1536 → 1024).
  Do it only after P0-1 and P0-2, and only if the bench says quality holds.

- [ ] **P1-6. Add an exact-query embedding cache — but measure reuse first.**
  Key on `(digest(normalized query), model, dimensions, normalization version)`,
  never raw text, tenant-scoped, bounded TTL, invalidated by model epoch. Skip
  it entirely if measured reuse is low; for agent workloads it often is not.

- [ ] **P1-7. Instrument cold-vs-warm explicitly.** Tag every external call with
  whether it reused a connection, and report warm/cold hit rates for the API-key
  principal, org, space, entitlement, and rate-limit caches. Right now the only
  way to see the cold path is to notice p95 is 20× p50.

- [ ] **P1-8. Fix the trace export gap.** Tempo shows 2 spans per trace — the
  custom `stages.span(...)` spans are not reaching the OTLP destination, so
  every waterfall in this doc had to be reconstructed from Loki log timestamps.
  That works but it is slow and lossy. Worth an hour to fix before the next
  optimization round.

---

## P1 — ingestion (carried forward, still correct)

- [ ] **Shadow-test one-pass memory + graph extraction.** Two serial LLM calls
  are 2256 ms of a ~3 s pipeline. Produce memories, temporal fields, entities,
  and relations in one structured response; keep the two-call pipeline as the
  fallback for malformed output. Compare fact completeness, entity/relation
  correctness, temporal accuracy, retries, token cost, and time-to-searchable.
  Target: ingestion p95 < 3.5 s with no quality regression.

- [ ] **Instrument real time-to-searchable.** `queue_wait` p50 of 5341 ms mixes
  actual startup delay with harmless durable-backstop delivery and cannot be
  used as an SLO. Separate `rpc_start_delay`, `queue_delivery_age`, and
  `time_to_searchable`; exclude `skipped_in_flight` from the processing metric.

- [ ] **Investigate `ingestion_job_claim` at 321 ms p50.** It is the third
  largest ingestion stage and is a plain database claim. Likely the same cold
  Hyperdrive path as P1-1.

- [ ] **Skip existing-memory hint work for provably empty spaces**
  (`existing_memory_embedding_batch`, 180 ms). Use a race-safe count or index
  epoch, not an eventually consistent guess.

---

## P2 — worth doing, but not for latency

- [ ] Separate retrieval and ingestion admission classes with weighted cost
  units and an accurate `Retry-After`. This is a **availability** fix — an
  ingestion burst currently starves interactive retrieval — not a latency fix.
  It was the previous doc's P0; it is correct work, mis-ranked.
- [ ] Calibrated abstention / no-match path for false-premise queries. A
  **quality** fix. Note that it does *not* save reranker time (flat cost).
- [ ] Intent-based graph gating. Only after P0-2 — if the traversal drops to
  ~35 ms, gating it is no longer worth the recall risk.
- [ ] SQL and Qdrant index auditing from query-plan evidence only. ANN is 23 ms;
  there is nothing here yet.

---

## Explicitly rejected

- **Disabling the reranker.** Gaming the benchmark. Already refuted by a
  production sample where a rerank-free query returned materially irrelevant
  results.
- **Reranking fewer candidates, or truncating documents before reranking.**
  Measured to return zero — rerank latency is flat in candidate count.
- **Disabling graph retrieval.** After P0-2 it will be ~35 ms. Removing a
  ranking signal to save 35 ms is a bad trade.
- **Moving or re-tuning Smart Placement.** Settled: targeted us-east-1 is
  configured and confirmed working by the flat cross-colo Qdrant timings.
- **Buying a graph database.** P0-2 gets most of the benefit for the price of
  one recursive CTE.
- **Rust / WASM / JS CPU rewrites.** A representative ingestion trace showed
  34 ms CPU against 2855 ms wall. There is no CPU problem.
- **Changing embedding dimensions in place.** Versioned collection + backfill or
  not at all.
- **Reading `cloudflare_colo` as the execution region.** It is the entry colo.
  Anything built on the other reading will be wrong.

---

## Done when

1. `search_total` p50 ≤ 500 ms and p95 ≤ 1.2 s, measured on the real corpus
   from a US caller, on a named deploy version.
2. Every latency change has a paired LongMemEval run with the reranker on in
   both arms, and no regression.
3. Rerank is no longer the largest stage.
4. The graph signal is one database round trip.
5. Cold-vs-warm is a reported dimension, not something inferred from a p50/p95
   ratio.
6. Ingestion has a version-attributed reduction in time-to-searchable, with
   `queue_wait` decomposed into real components.

## Reproducing these measurements

The probe was a throwaway script: 27 `POST /api/v1/search` calls paced 7 s apart
(the free plan allows 10 RPM), each carrying a unique `recall_id` so the request
can be found in Loki, across variants — real corpus, repeated query, `graph:false`,
`include_source:false`, the small controlled space, and a temporal query. Worth
re-creating as a committed script if this is repeated. Loki, `grafanacloud-logs`:

```logql
# stage p50 for US-executed requests
quantile_over_time(0.5,
  {service_name="crosmos-api-production"} | cloudflare_colo="IAD"
  | json | duration_ms != "" | unwrap duration_ms [24h]) by (stage)

# the flat-rerank finding
avg_over_time(
  {service_name="crosmos-api-production"} | json | stage="rerank"
  | unwrap duration_ms [24h]) by (candidate_count)
```

Tempo is reachable through the datasource proxy
(`/api/datasources/proxy/uid/grafanacloud-traces/api/search?q=...`); the native
MCP Tempo tools could not resolve the datasource. Note P1-8 — custom spans are
not currently exported, so Loki is the richer source.
