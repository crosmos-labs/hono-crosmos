# Ingestion and Retrieval: Now vs. After

_System-design and sequence diagrams for the approved no-regression changes,
2026-08-10._

## Scope

This document explains how the ingestion and retrieval system works today and
how it will work after the P0/P1 items in the
[engineering priority checklist](./ingestion-retrieval-priority-checklist-2026-08-10.md)
are implemented.

The “after” design is not a re-platforming proposal. It keeps the same Workers,
queue, database, vector store, and AI providers. The changes repair lifecycle
boundaries, prevent wasted work, bound existing queries, and activate existing
observability without removing any retrieval signal.

> **Implementation status:** the “after” diagrams are a proposed target. The
> unchecked P0/P1 checklist work has not started; these diagrams must not be
> read as the currently deployed production architecture.

> **Live-production context:** the “now” diagrams describe the customer-facing
> Hono system serving `api.crosmos.dev` today, including its live Neon data. Any
> database difference shown in an “after” diagram requires a staged,
> backward-compatible production migration; it is not a pre-production schema
> setup or a historical Python migration.

P2 experiments such as fact supersession, ANN overfetch, and ingestion request
idempotency are intentionally not shown as active behavior. They require
benchmark evidence before they can change the pipeline.

For a deeper code-backed description of the current system, see the
[ingestion and retrieval system design](./ingestion-retrieval-system-design.md).

## How to view the diagrams

All diagrams in this file are Mermaid diagrams.

- GitHub and many Git hosting tools render them automatically.
- In VS Code or Cursor, open Markdown Preview with `Ctrl/Cmd + Shift + V`.
- If a preview does not render Mermaid, use a Mermaid Markdown extension or
  paste only the contents of a `mermaid` block into
  [Mermaid Live Editor](https://mermaid.live/).

The diagrams describe logical requests. Arrows do not imply that every call is
synchronous; labels identify background, queue, and best-effort work where it
matters.

## Executive summary

The easiest way to understand the change is:

| Area | Now | After |
|---|---|---|
| Infrastructure | API Worker, Ingestion Worker, Queue, Neon, Qdrant, OpenAI, ZeroEntropy | The same components; no new broker or database |
| Large ingestion | A successful continuation retries the current queue delivery and consumes its failure-attempt budget | A successful continuation publishes a fresh message to the same queue; failure attempts remain for actual failures |
| Resume cleanup | The purge discovers checkpoint-scoped chunks but then deletes all chunks for the source | The purge deletes only the exact discovered chunk IDs |
| Space deletion | Parent row is hard-deleted immediately while workers or usage writes may still be running | Space is hidden immediately, workers are fenced, and physical cleanup happens after a grace period |
| Usage history | `daily_usage` is cascaded with the space and late writes can hit an FK error | Usage keeps the historical integer space ID without a live-space FK |
| Retrieval timeout | The API stops waiting after six seconds, but dependency work can continue | One deadline is propagated to cancellable work and prevents later stages from starting |
| Source attachment | Full raw source content is loaded for every fused candidate | Lightweight provenance is loaded for ranking; full content is loaded only for final top-K |
| Graph/keyword reads | Some bounds and field reductions happen after rows reach the Worker | Equivalent filters, limits, and projections happen in SQL |
| Logical recall retries | A DO supports `leaseKey`, but the API cannot supply one | Optional `recall_id` reaches the DO so one logical recall reuses one live lease |
| Speaker attribution | Extracted and normalized, then discarded before persistence | Stored additively; ranking remains unchanged |
| Metrics | Metrics calls exist but Analytics bindings are disabled | The same calls write to Analytics Engine with bounded-cardinality tags |

The retrieval result is deliberately unchanged: the same signals participate,
the same scoring and selection rules run, and `include_source=true` still
returns the complete original source.

## 1. Component architecture now

```mermaid
flowchart LR
  Client[SDK / agent / application]

  subgraph CF[Cloudflare]
    API[Hono API Worker]
    DO[RateLimiter Durable Object]
    KV[KV caches and coarse counters]
    Queue[Cloudflare ingestion queue]
    DLQ[Dead-letter queue]
    IW[Ingestion Worker]
    Cron[API scheduled maintenance]
    NoMetrics[Analytics calls<br/>bindings disabled]
  end

  subgraph Data[US East data plane]
    HD[Hyperdrive]
    PG[(Neon Postgres<br/>source of truth)]
    Q[(Qdrant<br/>derived vectors)]
  end

  subgraph Providers[External AI]
    OAI[OpenAI<br/>extraction + embeddings]
    ZE[ZeroEntropy<br/>reranking]
  end

  Client -->|HTTP| API
  API -->|admission| DO
  API -->|auth/cache/counters| KV
  API --> HD --> PG
  API -->|semantic and MMR vectors| Q
  API -->|query embedding| OAI
  API -->|candidate rerank| ZE

  API -->|durable job copy| Queue
  API -.->|low-latency RPC kick| IW
  Queue -->|delivery / redelivery| IW
  Queue -->|attempts exhausted| DLQ

  IW --> HD
  IW -->|extract and embed| OAI
  IW -->|upsert / delete vectors| Q
  Cron --> HD

  API -.->|no-op| NoMetrics
  IW -.->|no-op| NoMetrics
```

### What this means

There are two entry paths into ingestion, but only one ingestion job:

- The service-binding RPC makes a new job start quickly.
- The queue message is the durable copy that recovers the job if the RPC run
  never starts or its Worker isolate disappears.
- A Postgres compare-and-set claim prevents a healthy RPC run and its queue copy
  from processing the job at the same time.

Retrieval runs inline in the API Worker because the client needs an immediate
answer. Postgres remains the authorization authority; Qdrant supplies candidate
IDs and scores but cannot independently decide which private memories the
caller may see.

The main problem is not the component selection. It is that several lifecycle
states share one mechanism: queue retries represent failures, healthy polling,
and successful continuation; immediate space deletion races background work;
and the route timeout is not the dependency deadline.

## 2. Component architecture after the approved changes

```mermaid
flowchart LR
  Client[SDK / agent / application]

  subgraph CF[Cloudflare - same platform]
    API[Hono API Worker<br/>request deadline + lightweight provenance]
    DO[RateLimiter Durable Object<br/>token + optional recall_id]
    KV[KV caches and coarse counters]
    Queue[Same Cloudflare ingestion queue]
    DLQ[Dead-letter queue<br/>actual exhausted failures]
    IW[Ingestion Worker<br/>space fence + exact checkpoint purge]
    Cron[Existing scheduled maintenance<br/>retries + tombstone finalizer]
    AE[Analytics Engine<br/>bounded-cardinality metrics]
  end

  subgraph Data[US East data plane]
    HD[Hyperdrive]
    PG[(Neon Postgres<br/>active + tombstoned spaces<br/>retained usage history)]
    Q[(Qdrant<br/>derived vectors)]
  end

  subgraph Providers[External AI - unchanged]
    OAI[OpenAI<br/>extraction + embeddings]
    ZE[ZeroEntropy<br/>reranking]
  end

  Client -->|HTTP + optional recall_id| API
  API -->|idempotent logical lease| DO
  API -->|auth/cache/counters| KV
  API --> HD --> PG
  API -->|bounded, cancellable calls| Q
  API -->|cancellable query embedding| OAI
  API -->|cancellable rerank| ZE

  API -->|durable job copy| Queue
  API -.->|low-latency RPC kick| IW
  Queue -->|job or failure retry| IW
  IW -->|fresh successful continuation| Queue
  Queue -->|real attempts exhausted| DLQ

  IW --> HD
  IW -->|extract and embed| OAI
  IW -->|upsert / purge vectors| Q
  Cron -->|finalize tombstones in bounded pages| HD
  Cron -->|purge vectors before hard delete| Q

  API --> AE
  IW --> AE
  Cron --> AE
```

### What changed

The Ingestion Worker gains a producer binding to the same queue. This does not
create another queue or another processing system. It lets a completed chunk
window publish a fresh continuation without pretending that successful progress
was a failed delivery.

The database gains small lifecycle fields and constraints:

- `memory_spaces.deleted_at` marks a space as immediately unavailable.
- The active-space name index ignores tombstones so a name can be reused.
- `daily_usage.space_id` stays as a historical integer, but no longer references
  a currently existing space row.
- Memories store nullable speaker attribution that extraction already emits.

The API Worker gains a request-scoped deadline and the ability to pass an
optional logical recall ID to the existing concurrency Durable Object. Retrieval
queries transfer less data, but the ranking pipeline itself is unchanged.

Analytics Engine is not a new business dependency in the request path. Metrics
remain best-effort: a metrics failure cannot fail ingestion or retrieval.

### What did not change

- No Kafka, new queue technology, graph database, or multi-region database.
- No removal of the RPC fast path or durable queue backstop.
- No replacement of Neon or Qdrant.
- No removal or reweighting of semantic, keyword, graph, or temporal signals.
- No changes to RRF, reranker thresholds, recency weights, temporal boosts,
  session diversity, or MMR.
- No change to the public `source` field: it remains the original full source
  when requested.

## 3. Ingestion sequence now

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant API as API Worker
  participant PG as Neon Postgres
  participant Q as Cloudflare Queue
  participant IW as Ingestion Worker
  participant AI as OpenAI
  participant VS as Qdrant

  Client->>API: POST source or conversation
  API->>PG: Preflight, insert source, create pending job
  par Durable backstop
    API->>Q: Send job message
  and Low-latency fast path
    API->>IW: ingest(job) over service binding
  end
  API-->>Client: 202 Accepted + job/source IDs

  IW->>PG: CAS claim pending -> processing
  Q->>IW: Deliver durable copy
  IW->>PG: CAS claim

  alt Another trigger has a live lease
    PG-->>IW: in_flight
    IW-->>Q: Retry delivery after delay
  else This trigger owns the job
    loop Up to the per-invocation chunk budget
      IW->>PG: Load source and checkpoint
      Note over IW,PG: Resume purge discovers chunks >= checkpoint,<br/>but current final delete removes all source chunks
      IW->>AI: Extract facts and embeddings
      AI-->>IW: Facts, entities, vectors
      IW->>PG: Persist chunks, memories, edges, checkpoint
      IW->>VS: Upsert vectors
    end

    alt More chunks remain
      IW->>PG: Reset job to pending
      IW-->>Q: Retry the same delivery
      Note over Q,IW: Successful continuation consumes<br/>the same max_retries budget as failures
    else Transient provider failure
      IW->>PG: Reset job to pending
      IW-->>Q: Retry the same delivery
    else Complete
      IW->>PG: Mark source/job terminal
      IW-->>Q: Acknowledge delivery
    end
  end

  opt Delivery attempts are exhausted
    Q->>Q: Move message to DLQ
  end
```

### Where the current sequence is fragile

1. **A healthy large source can look like a failing message.** Every continuation
   increments the same delivery-attempt counter used for provider or database
   failures.
2. **Resume cleanup is broader than its discovery query.** Earlier completed
   chunks can be removed even though their associated memories remain.
3. **Deletion is only noticed between some units of work.** The parent space can
   disappear while an external call or persistence stage is still active.
4. **Metrics do not reach a sink.** Logs show individual failures, but there is
   no low-cardinality time series for continuation depth, checkpoint progress,
   or DLQ rate.

The queue/RPC design itself is still valuable. The error is treating progress
as retry failure, not having two triggers.

## 4. Ingestion sequence after the approved changes

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant API as API Worker
  participant PG as Neon Postgres
  participant Q as Same ingestion queue
  participant IW as Ingestion Worker
  participant AI as OpenAI
  participant VS as Qdrant
  participant AE as Analytics Engine

  Client->>API: POST source or conversation
  API->>PG: Preflight, insert source, create pending job
  par Durable backstop
    API->>Q: Send original job message
  and Low-latency fast path
    API->>IW: ingest(job) over service binding
  end
  API-->>Client: 202 Accepted + unchanged response

  IW->>PG: CAS claim and verify active space

  alt Job cancelled or space tombstoned
    IW->>PG: Preserve cancelled terminal state
    IW->>AE: Record cancellation outcome
  else This trigger owns an active job
    loop Bounded chunk window
      IW->>PG: Load source + checkpoint
      IW->>PG: Purge exact chunk IDs at or after checkpoint
      IW->>PG: Re-check job and space fence
      IW->>AI: Extract facts and embeddings
      AI-->>IW: Facts including speaker_role
      IW->>PG: Re-check fence before destructive persistence
      IW->>PG: Persist artifacts + speaker_role + checkpoint
      IW->>VS: Upsert vectors
      IW->>AE: Record stage and checkpoint progress
    end

    alt Queue-owned run made progress and more chunks remain
      IW->>PG: Reset job to pending
      IW->>Q: Publish fresh continuation message
      alt Continuation publish succeeds
        IW-->>Q: Acknowledge current delivery
      else Continuation publish fails
        IW-->>Q: Retry current delivery
      end
    else RPC run made progress and more chunks remain
      IW->>PG: Reset job to pending
      Note over Q,IW: Original durable queue copy<br/>claims and continues the job
    else Transient provider failure
      IW->>PG: Reset job to pending
      IW-->>Q: Retry current delivery
    else Complete
      IW->>PG: Mark source/job terminal with guarded CAS
      IW-->>Q: Acknowledge queue delivery, if owned
    end
  end
```

### Why this sequence is safer

- **Progress and failure are different states.** A fresh continuation starts
  with a fresh delivery-attempt counter. A genuinely failing dependency still
  consumes the bounded failure budget and can reach the DLQ.
- **Checkpoint work is monotonic.** A resumed invocation removes only artifacts
  it is allowed to recreate. Completed earlier chunks remain valid evidence.
- **Deletion becomes a write fence.** The worker checks both the job and the
  parent space before expensive or destructive stages. A cancelled job cannot
  be revived by a heartbeat.
- **The original queue safety property remains.** The RPC path does not publish
  duplicate continuations; its original queue copy remains the recovery path.
- **No extraction signal is removed.** Facts, temporal values, entities, edges,
  visibility, and citations remain. Speaker attribution is additionally stored.

## 5. Retrieval sequence now

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant API as API Worker
  participant DO as Concurrency DO
  participant PG as Neon Postgres
  participant OAI as OpenAI embeddings
  participant VS as Qdrant
  participant ZE as ZeroEntropy

  Client->>API: POST /search
  API->>DO: Acquire tokenized user lease
  DO-->>API: Lease token or 429
  API->>PG: Entitlements, space access, quota

  par Query embedding
    API->>OAI: Embed query
  and Visibility and setup
    API->>PG: Resolve visible users and scope
  end

  par Semantic signal
    API->>VS: ANN search by space
    VS-->>API: Candidate IDs + cosine scores
    API->>PG: Hydrate and visibility-filter IDs
  and Keyword signal
    API->>PG: Full-text query returning full memory rows
  and Graph signal
    API->>PG: Seed and fetch all matching hop edges
    Note over API,PG: Confidence filter and hop cap<br/>are applied later in JavaScript
  and Temporal signal
    API->>PG: Time-range candidates, when applicable
  end

  API->>API: RRF fusion
  par Rerank fused candidates
    API->>ZE: Rerank candidate content
  and Attach source data
    API->>PG: Load full raw source for every fused candidate
  end
  API->>API: Recency/temporal boost, floor, session diversity or MMR
  API-->>Client: Final top-K with optional full source

  par Background bookkeeping
    API->>PG: Touch selected memories
  and Background usage
    API->>PG: Upsert daily_usage with live-space FK
  end
  API->>DO: Release owned lease token

  Note over API,OAI: Route timeout stops awaiting after 6 seconds,<br/>but already-started dependency work may continue
```

### What the retrieval sequence already does well

- Semantic, keyword, graph, and temporal signals run in parallel.
- RRF combines rank evidence without requiring incomparable raw scores to share
  a scale.
- Semantic retrieval is essential; auxiliary signal failures degrade visibly
  instead of turning every search into a 500.
- Qdrant candidates are hydrated through Postgres visibility rules.
- Rerank fallback, recency/temporal adjustment, relevance floor, and diversity
  are explicit stages.
- Concurrency leases are token-owned and released in `finally`.

The proposed work does not replace any of this. It shortens the amount of data
and work surrounding the ranking stages.

## 6. Retrieval sequence after the approved changes

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant API as API Worker
  participant DO as Concurrency DO
  participant PG as Neon Postgres
  participant OAI as OpenAI embeddings
  participant VS as Qdrant
  participant ZE as ZeroEntropy
  participant AE as Analytics Engine

  Client->>API: POST /search + optional recall_id
  API->>API: Create one 6-second deadline signal
  API->>DO: Acquire token using optional recall_id as leaseKey
  DO-->>API: New/reused lease token or 429
  API->>PG: Entitlements, active-space access, quota

  par Cancellable query embedding
    API->>OAI: Embed query with deadline
  and Visibility and setup
    API->>PG: Resolve visible users and scope
  end

  par Semantic signal - same scoring
    API->>VS: Cancellable ANN search
    VS-->>API: Candidate IDs + cosine scores
    API->>PG: Hydrate and visibility-filter IDs
  and Keyword signal - same scoring
    API->>PG: Full-text query with required columns only
  and Graph signal - same scoring
    API->>PG: Confidence/order/edge cap applied in SQL
  and Temporal signal - same scoring
    API->>PG: Time-range candidates, when applicable
  end

  API->>API: Same RRF fusion
  par Cancellable rerank
    API->>ZE: Rerank candidate content with deadline
  and Lightweight provenance
    API->>PG: Source ID, UUID, session_id only for fused candidates
  end
  API->>API: Same boosts, floor, session diversity or MMR

  opt include_source is true
    API->>PG: Load full source only for unique final top-K source IDs
  end

  API-->>Client: Same final top-K response contract
  API->>AE: Record bounded stage/candidate/deadline metrics

  par Background bookkeeping
    API->>PG: Touch selected memories
  and Background usage
    API->>PG: Upsert retained daily_usage history
  end
  API->>DO: Release owned lease token

  alt Deadline expires at any point
    API-->>Client: 504 with existing retry behavior
    API-xOAI: Abort cancellable embedding work
    API-xVS: Abort cancellable vector work
    API-xZE: Abort cancellable rerank work
    Note over API,PG: Do not launch later stages after expiry
  end
```

### Why retrieval accuracy stays the same

The changes happen around the ranking math, not inside it:

1. **SQL bounds reproduce existing JavaScript behavior.** Graph edges use the
   same confidence rule, effective-time ordering, ID tie-breaker, and hop limit.
2. **Projection changes fields, not rows.** Keyword search returns the same
   matching rows and ranks, but does not transfer unused columns.
3. **Session metadata still arrives before selection.** Lightweight provenance
   includes `session_id`, so session diversity makes the same choices.
4. **Full source loading moves after selection.** This changes how many source
   bytes are loaded, not the source chosen or the value returned.
5. **Cancellation changes only work that has exceeded the existing deadline.**
   A request that completes within six seconds must produce an identical result.
6. **`recall_id` affects admission, not ranking.** It prevents copies of one
   logical request from occupying several live slots.

Every ranking-neutral change is gated by exact differential fixtures. If
candidate IDs, ordering, scores, source text, or top-K differ, the optimization
does not ship until the difference is explained and explicitly approved.

## 7. Space deletion sequence now

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant API as API Worker
  participant PG as Neon Postgres
  participant IW as Ingestion Worker
  participant VS as Qdrant

  Client->>API: DELETE /spaces/{uuid}
  API->>PG: Load live space
  API->>PG: Mark its jobs cancelled
  API->>PG: Collect all memory/entity IDs
  API->>PG: Hard-delete space and cascade children
  API-->>Client: 204 No Content
  API->>VS: Best-effort vector purge in background

  par In-flight ingestion
    IW->>PG: Continue after external AI call
    PG-->>IW: Parent-row FK failure or missing job/source
  and Late usage metering
    API->>PG: Upsert daily_usage
    PG-->>API: Space FK failure
  and Vector purge failure
    VS-->>API: Error after authoritative rows are gone
  end
```

### Why immediate hard deletion is difficult to recover

Cancelling a job changes database state, but it cannot instantly cancel an
already-running external request. The Worker may resume after the parent space
has been deleted. Similarly, search usage is intentionally written in the
background and may execute after the response and delete race.

Deleting Postgres rows before Qdrant vectors also removes the easiest inventory
of vector IDs. A failed best-effort purge can therefore leave derived vectors
without an authoritative row to drive a retry.

## 8. Space deletion sequence after the approved changes

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant API as API Worker
  participant Cache as Space gate cache
  participant PG as Neon Postgres
  participant IW as Ingestion Worker
  participant Cron as Existing maintenance cron
  participant VS as Qdrant
  participant AE as Analytics Engine

  Client->>API: DELETE /spaces/{uuid}
  API->>PG: Atomically set deleted_at
  API->>PG: Cancel pending/processing jobs
  API->>Cache: Invalidate active-space entry
  API-->>Client: 204 No Content

  Note over API,PG: Normal APIs now treat the space as absent,<br/>but rows remain available for safe cleanup

  IW->>PG: Check job status and active-space fence
  PG-->>IW: Cancelled / tombstoned
  IW->>PG: Stop without reviving job status
  IW->>AE: Record observed cancellation

  Note over PG: Wait at least one ingestion lease interval
  Cron->>PG: Select a bounded tombstone page
  Cron->>PG: Verify no active jobs and page vector IDs
  Cron->>VS: Delete memory/entity vectors in bounded pages

  alt Vector purge fails
    VS-->>Cron: Retryable error
    Cron->>PG: Leave tombstone and rows intact
    Cron->>AE: Record failed finalization
  else Vector purge succeeds
    VS-->>Cron: Success
    Cron->>PG: Hard-delete space and cascade children
    Cron->>AE: Record completed finalization
  end

  Note over API,PG: daily_usage keeps the historical space_id<br/>and is not part of the space cascade
```

### What the user experiences

Deletion still feels immediate. As soon as `deleted_at` is committed and the
cache is invalidated, normal read, search, source, and ingestion APIs treat the
space as missing. The delay applies only to physical cleanup.

The grace period solves the race without making the DELETE request wait for AI
calls, queue leases, or a large vector purge. Anything an old Worker committed
before observing the fence remains under the tombstoned parent and is included
in final cleanup.

Vector deletion happens before the final database cascade. If it fails, the
next cron can derive the IDs again and repeat the idempotent deletion. Usage
history is independent of this lifecycle and remains available for billing and
audit.

## 9. Failure behavior now vs. after

| Failure | Now | After |
|---|---|---|
| RPC isolate disappears | Queue copy recovers after lease expiry | Same behavior |
| Queue sees healthy RPC run | Retries current delivery | Same, because durable copy must survive until the RPC run settles |
| Large source needs another window | Retries current delivery and burns an attempt | Publishes fresh continuation after checkpoint progress |
| Continuation publish fails | Not a separate operation today | Current delivery is retried; durable work is not acknowledged away |
| Transient LLM/embed/vector error | Bounded local retry, then queue redelivery | Same; actual failure still consumes failure budget |
| Resumed partial batch | May delete earlier source chunks | Deletes exact checkpoint-scoped chunk IDs only |
| Search auxiliary signal fails | Empty signal contribution with log | Same, plus metric |
| Semantic signal fails | Search fails loudly | Same; no misleading keyword-only answer |
| Search exceeds six seconds | Client gets timeout; work may continue | Client gets timeout; cancellable work aborts and later stages do not start |
| Source lookup is expensive | Full source loaded for all fused candidates | Full source loaded only for selected results |
| Space deleted during ingestion | Worker can hit missing-parent failures | Tombstone fences writes; delayed cascade cleans everything |
| Vector cleanup fails | Parent rows may already be gone | Tombstone remains, so cleanup is retryable |
| Late usage write after deletion | FK failure | Historical usage upsert succeeds |
| Metrics sink unavailable | Metrics are already no-op | Remain best-effort; pipeline behavior is unaffected |

## 10. Data and interface changes

```mermaid
erDiagram
  MEMORY_SPACES ||--o{ SOURCES : owns
  MEMORY_SPACES ||--o{ MEMORIES : owns
  MEMORY_SPACES ||--o{ INGESTION_JOBS : schedules
  SOURCES ||--o{ CHUNKS : splits_into
  CHUNKS }o--o{ MEMORIES : supports
  MEMORIES }o--o{ ENTITIES : mentions
  ENTITIES ||--o{ EDGES : participates_in
  ORGANIZATIONS ||--o{ DAILY_USAGE : retains
  USERS ||--o{ DAILY_USAGE : attributes

  MEMORY_SPACES {
    int id PK
    uuid uuid
    timestamp deleted_at "new nullable tombstone"
  }
  MEMORIES {
    int id PK
    int space_id FK
    string speaker_role "new nullable signal"
  }
  INGESTION_JOBS {
    uuid id PK
    int space_id FK
    string status
  }
  DAILY_USAGE {
    int org_id FK
    int user_id FK
    int space_id "historical ID, no live-space FK"
    date date
  }
```

The public changes are additive or behavior-compatible:

- Search accepts an optional UUID `recall_id`. Requests without it behave as
  they do now.
- Search response fields and scoring remain unchanged.
- Ingestion acceptance responses remain unchanged.
- Space deletion still returns `204`; deleted spaces immediately read as
  absent.
- `speaker_role` is internal in this phase and does not alter the memory API or
  ranking.
- Queue messages may carry an internal `continuation_count` for safety and
  observability.

## 11. Safe delivery sequence

```mermaid
flowchart LR
  A[Deterministic ingestion and retrieval baselines]
  B[Exact purge fix]
  C[Fresh queue continuations]
  D[Incident and large-source replay]
  E[Analytics bindings and metrics]
  F[Deferred deletion and usage migration]
  G[Deadline propagation]
  H[Provenance split and SQL bounds]
  I[recall_id and speaker_role]
  J[P2 experiments only after benchmark evidence]

  A --> B --> C --> D
  A --> E
  D --> F
  E --> F
  F --> G --> H --> I --> J
```

This ordering is important:

1. Baselines make “nothing broke” measurable.
2. Purge and continuation correctness are fixed before performance work.
3. Metrics are enabled before lifecycle changes need production monitoring.
4. Deferred deletion ships through an additive migration and staged finalizer.
5. Retrieval changes ship one at a time and must match the baseline exactly.
6. Anything capable of changing recall remains a later, benchmark-gated
   experiment rather than being bundled into the simplification work.

## Final design takeaway

The after-design is intentionally boring in the best sense: it keeps the
current components and makes each one own a clearer responsibility.

- The queue represents durable work and real retries; a fresh message represents
  successful continuation.
- The checkpoint defines exactly which ingestion artifacts may be recreated.
- A tombstone separates “unavailable to users” from “safe to physically purge.”
- The route deadline becomes the deadline of downstream retrieval work.
- Provenance needed for ranking stays early; large source content moves late.
- SQL bounds data before it reaches the Worker without changing ranking rules.
- Metrics describe behavior without becoming a correctness dependency.

That gives the system more predictable failure handling and better scaling
without trading away ingestion fidelity or retrieval accuracy.
