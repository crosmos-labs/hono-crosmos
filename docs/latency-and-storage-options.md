# Latency & Storage Architecture — Options

> Research date: **2026-06-09**. This is an options/exploration doc, not a committed
> plan. It records the architecture discussion about reducing global retrieval
> latency and where the relational/graph/vector stores should live. Nothing here
> is decided; each section lists options and trade-offs only.

## Context

- Primary users are global: America, Europe, India, China.
- Two named latency sources (`docs`/`.codex` `current-problems.md`):
  1. **DB latency** — single-region Neon Postgres; no regional replicas. Every
     DB-heavy request pays distance to one region.
  2. **External AI latency** — query embedding (OpenAI) and reranking
     (ZeroEntropy) are US-based round trips on the user-facing read path.
- Current observed retrieval latency: a couple of seconds. Target: sub-second
  without sacrificing ranking quality.
- Cost is a real constraint; always-on regional clusters are unattractive.
- Goal direction: keep as much as possible on Cloudflare. Things that cannot stay
  on Cloudflare may be deployed on AWS multi-region as a fallback.
- Future: a self-host option for enterprise (bring-your-own relational / graph /
  vector store).

## Key structural fact this all hinges on

Everything is partitioned by **space** (`TenantScope` = orgId + spaceId, enforced
everywhere). Retrieval never crosses spaces:

- Every search is scoped to one `spaceId`.
- `loadRetrievalCandidates` already loads one space's *entire* working set
  (memories, entities, memory→entity map) into memory per query.
- Graph BFS (`features/search/signals/graph.ts`) only traverses within one space.

Consequence: "one isolated store per space" is a natural fit, and the
load-the-whole-space pattern (a liability when the DB is remote) becomes an
advantage when the store is co-located with compute.

---

## Decision 1 — Where does per-space hot data live? (relational + graph + vector)

This is the data plane: memories, entities, edges, embeddings — the set retrieval
loads on every query. This is the actual latency bottleneck.

### Option A — Durable Object per space (SQLite-in-DO)

Reference: https://boristane.com/blog/durable-objects-graph-databases/

One DO per space holds that space's relational rows + graph + (small) vectors in
local SQLite. Retrieval query pushed into the DO; graph BFS + cosine run
data-local; only top-k returned.

- **Pros:** kills DB-trip latency (local disk read, no Hyperdrive/cross-region);
  graph BFS is the blog's exact model; reuses existing hand-written cosine
  (`vector.ts`); per-space isolation matches tenancy 1:1; single-writer strong
  consistency per space suits ingestion; pay-per-active-time fits cost
  constraint; "no cross-graph queries" limitation does not apply to us.
- **Cons / limits to design around:**
  - **10 GB per DO** ceiling (~1.6M 1536-dim float32 vectors before text/edges).
    Huge spaces overflow → need Vectorize for the vector signal on big spaces.
  - **Single-threaded per DO** — a hot space serializes all its queries; our
    retrieval is CPU-heavy (cosine + fusion + MMR).
  - **Single-region primary per space** — one side pays cross-region on writes.
  - **Cold starts** on idle spaces, on a latency-sensitive read path.
  - Newer / less battle-tested than Postgres; early-adopter risk.
  - Deepens Cloudflare lock-in (mitigated only if hidden behind a port).
- **Mitigations:** DO SQLite **read replicas** (reads spread across regions; fits
  read-heavy retrieval + async ingestion); keep heavy scoring in the stateless
  Worker and push only the candidate-fetch/graph-hop into the DO; Vectorize
  overflow for large spaces.

### Option B — External managed relational + separate graph + Vectorize

Relational on PlanetScale (or Neon read replicas) multi-region; graph on a managed
graph DB; vectors on Cloudflare Vectorize.

- **Pros:** mature, well-understood; clear self-host story (swap connection
  strings / standard engines).
- **Cons:** PlanetScale is MySQL/Vitess — **not pgvector-compatible**, forces
  vectors out of the relational DB anyway (so Vectorize becomes mandatory, not
  optional), and forces a Drizzle dialect + schema rewrite from `pg-core`.
  Still ships the working set over the wire per query unless retrieval is
  redesigned away from load-all. Managing cross-region relational **and** graph
  is the operational annoyance we're trying to avoid.

### Option C — Hybrid (recommended framing to explore)

- **Control plane** (users, orgs, api_keys, OAuth, billing, space *metadata*,
  jobs): one managed relational DB. Low-volume, **already KV-cached**, so not the
  latency killer. Fine to leave on AWS/Neon/PlanetScale multi-region if not on
  Cloudflare. Do **not** spend effort multi-regioning this.
- **Data plane** (per-space hot set): Durable Object per space (Option A).
- **Large-space vector overflow:** Vectorize.

Anti-pattern to avoid: globally replicating the cached control plane while the
per-space working set still travels cross-region.

### Fallback (stated goal)

Whatever genuinely cannot live on Cloudflare → AWS multi-region. Applies most
naturally to the control-plane relational DB, least to the per-space hot data
(which must be edge-local to win).

---

## Decision 2 — External AI latency (independent of Decision 1)

DO/storage changes do **nothing** for the OpenAI + ZeroEntropy US round trips.
This is a separate, possibly faster, win.

### Option A — Move embeddings + reranking to Cloudflare Workers AI

- **Pros:** runs on the CF edge globally; removes two trans-continental round
  trips from every search; likely the fastest available latency win; independent
  of the storage re-platforming.
- **Cons:** Workers AI embedding models are **768/1024-dim**, not 1536 → full
  re-embed of the corpus + schema/index dimension change; ranking-quality
  validation required against current OpenAI + ZeroEntropy behavior.

### Option B — Keep OpenAI/ZeroEntropy, add regional caching/proxy

- **Pros:** no re-embed; preserves current quality.
- **Cons:** doesn't fix first-call latency for novel queries; limited upside.

### Option C — Mixed

Workers AI for reranking (bge-reranker), keep OpenAI embeddings (or vice versa),
based on which has the better quality/latency trade-off in testing.

---

## Decision 3 — Abstraction prerequisite (enables both the migration and self-host)

Independent of which options above are chosen.

- Today, semantic search (`signals/semantic.ts`) and graph BFS
  (`signals/graph.ts`) take a Drizzle `Database` handle directly — the only two
  external dependencies **not** behind a port (cache, queue, job-store, email,
  rate-limit, embeddings, reranker, LLM all already are).
- **Option:** introduce `VectorStore` / `GraphStore` (and a per-space
  `SpaceStore`) ports now, with the current Postgres code as the first adapter.
  - Makes the DO adapter, Vectorize adapter, and enterprise BYO adapters
    drop-in instead of orchestrator surgery.
  - Keeps the self-host promise intact (cloud = DO/Vectorize adapters;
    self-host = Postgres+pgvector / Neo4j adapters; same orchestrator).
- Coupled item: retrieval should shift from "load the whole space then compute in
  JS" toward "query the store for what's needed" — prerequisite for both
  Vectorize and any large-space scaling, regardless of Decision 1.

---

## Cross-cutting constraints to remember

- **Embedding dimension is load-bearing.** `1536` is baked into the schema and
  index. Any embedding-provider change = migration + full re-embed; you cannot
  run two providers against one index. "Multiple embedding providers" is realistically a
  *per-deployment* choice (separate index per provider), not per-request.
- **Provider factory pattern already exists** for LLMs (`getLLM` switches on
  `LLM_PROVIDER`). Embeddings/reranker factories are currently single-provider —
  generalize them to the same shape when adding Workers AI.
- Ingestion is allowed to be eventually consistent (Queues) but must be durable.
  Read-heavy retrieval + async writes is what makes DO read replicas viable.

## Open questions that change the recommendation

1. **Space size distribution (typical + p99 max memory count).** If ~all spaces
   fit well under the DO ceiling → vectors-in-DO is clean, Vectorize is rare
   overflow. If spaces reach millions of memories → Vectorize-for-vectors +
   DO-for-graph from day one.
2. **Is a single space ever read from multiple regions at once** (shared team
   space) or effectively pinned to one region? Global spaces make DO read
   replicas a hard requirement rather than a nice-to-have.

## Suggested sequencing (not committed)

1. Decision 3 ports (`VectorStore`/`GraphStore`) — low-risk, unblocks everything.
2. Decision 2 (Workers AI) — independent, possibly fastest user-visible win.
3. Decision 1 — prototype DO-per-space behind the new ports; validate against the
   two open questions before committing.
