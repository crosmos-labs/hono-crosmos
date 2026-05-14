# Cloudflare Workers Migration Plan

## Context

**Why migrate?** AWS Lambda charges for wall time; Cloudflare Workers charges for CPU time. Our workloads are I/O-bound:
- Ingestion: 10-20s wall time, ~2s CPU (waiting on OpenAI/LLM)
- Retrieval: 1-2s wall time, ~200ms CPU (waiting on DB/reranker)

**Current state:** Python/FastAPI monolith with ARQ (Redis) for background jobs.

**Target state:** TypeScript/Hono on Cloudflare Workers with NeonDB via Hyperdrive.

---

## Tech Stack

```
├── Runtime:        Cloudflare Workers (Unbound)
├── Language:       TypeScript
├── Framework:      Hono
├── Database:       NeonDB (PostgreSQL + pgvector)
├── DB Connection:  Hyperdrive (connection pooling)
├── ORM:            Drizzle ORM
├── Queue:          Cloudflare Queues
├── Cache:          Cloudflare KV
├── Validation:     Zod
├── Embeddings:     OpenAI (text-embedding-3-small)
├── LLM:            OpenRouter (gpt-4.1-mini)
├── Reranker:       ZeroEntropy (zerank-2)
├── Payments:       Polar
├── Email:          Resend
├── Error Tracking: Sentry (@sentry/cloudflare)
└── Monorepo:       Turborepo + Bun
```

### Why Drizzle?

| Feature | Drizzle | Prisma |
|---------|---------|--------|
| Bundle size | ~50KB | ~2MB+ |
| Edge runtime | Native support | Requires adapter |
| Type safety | Full inference | Full inference |
| Raw SQL | First-class | Escape hatch |
| Migrations | SQL-based | Prisma schema |

Drizzle is ideal for Workers: small bundle, no runtime overhead, works directly with Hyperdrive's `postgres` connection.

```typescript
// Example: Drizzle with Hyperdrive
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export default {
  async fetch(request: Request, env: Env) {
    const sql = postgres(env.HYPERDRIVE.connectionString);
    const db = drizzle(sql);
    
    const users = await db.select().from(usersTable);
    return Response.json(users);
  }
};
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Edge                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌────────────────────┐              ┌────────────────────┐            │
│   │   API Gateway      │              │  Ingestion Worker  │            │
│   │   (Hono Worker)    │              │  (Queue Consumer)  │            │
│   │                    │   CF Queue   │                    │            │
│   │ • Auth (KV cache)  │─────────────▶│ • Memory extract   │            │
│   │ • /sources         │              │ • Embed + persist  │            │
│   │ • /search          │              │ • Entity resolve   │            │
│   │ • /spaces          │              │ • Edge creation    │            │
│   │ • /auth/*          │              └─────────┬──────────┘            │
│   │ • /billing/*       │                        │                       │
│   │ • /webhooks/polar  │                        │                       │
│   └─────────┬──────────┘                        │                       │
│             │                                   │                       │
│   ┌─────────▼──────────┐                        │                       │
│   │   KV Store         │                        │                       │
│   │ • API key cache    │                        │                       │
│   │ • Rate limit state │                        │                       │
│   └────────────────────┘                        │                       │
│                                                 │                       │
└─────────────────────────────────────────────────┼───────────────────────┘
                                                  │
                    ┌─────────────────────────────┼─────────────────────────┐
                    │                             │                         │
                    ▼                             ▼                         ▼
          ┌─────────────────┐           ┌─────────────────┐       ┌─────────────────┐
          │    NeonDB       │           │    OpenAI       │       │   OpenRouter    │
          │  (Hyperdrive)   │           │   Embeddings    │       │   (LLM)         │
          │                 │           │                 │       │                 │
          │ • pgvector HNSW │           │ text-embed-3-sm │       │ gpt-4.1-mini    │
          │ • GIN fulltext  │           └─────────────────┘       └─────────────────┘
          │ • Drizzle ORM   │
          └─────────────────┘
                    │
                    ▼
          ┌─────────────────┐
          │   ZeroEntropy   │
          │   (Reranker)    │
          │   zerank-2      │
          └─────────────────┘
```

---

## Payments: Workers vs Always-On Instance

### Recommendation: **Keep on Workers**

The current Polar webhook handler is fast:
1. Verify signature (~1ms CPU)
2. Insert to `billing_events` (~10ms DB)
3. Update `organization` subscription state (~10ms DB)

Total: **<50ms CPU, <500ms wall time** — well within Workers limits.

### When to use an instance instead:

| Scenario | Workers OK? | Use Instance If... |
|----------|-------------|-------------------|
| Polar webhooks | ✅ Yes | Never needed |
| Stripe webhooks | ✅ Yes | Complex invoice generation |
| Usage metering | ✅ Yes | Real-time aggregation across 1M+ events |
| Subscription sync | ✅ Yes | Batch jobs that run >30s CPU |

**Verdict:** Workers handles webhooks fine. The 30s limit is CPU time — a webhook that waits 5s for Polar's API uses ~10ms CPU.

If you're still concerned, you can add a **billing instance** later as a fallback. For now, Workers is simpler and cheaper.

---

## Request Flows with Latency Breakdown

### Flow 1: Space Lookup (What AI Agents Do First)

```
Agent/Client                    API Gateway                      NeonDB
    │                               │                               │
    │  GET /spaces                  │                               │
    │  Authorization: csk_xxx       │                               │
    │──────────────────────────────▶│                               │
    │                               │                               │
    │                     ┌─────────┴─────────┐                     │
    │                     │ Auth: KV lookup   │                     │
    │                     │ ~5ms (cache hit)  │                     │
    │                     │ ~50ms (cache miss)│                     │
    │                     └─────────┬─────────┘                     │
    │                               │                               │
    │                               │  SELECT * FROM memory_spaces  │
    │                               │  WHERE org_id = ?             │
    │                               │──────────────────────────────▶│
    │                               │                               │
    │                               │◀──────────────────────────────│
    │                               │  ~20ms (Hyperdrive pooled)    │
    │                               │                               │
    │◀──────────────────────────────│                               │
    │  200 OK [{space_id, name}]    │                               │
    │                               │                               │

Total latency: 25-70ms (depending on KV cache)
```

**Latency breakdown:**
| Step | Time | Notes |
|------|------|-------|
| Edge routing | ~5ms | Cloudflare edge |
| Auth (KV hit) | ~5ms | Cached API key |
| Auth (KV miss) | ~50ms | DB lookup + cache write |
| DB query | ~20ms | Hyperdrive connection pooling |
| **Total** | **25-75ms** | |

---

### Flow 2: Retrieval (Search Query)

```
Agent/Client                    API Gateway                      External
    │                               │                               │
    │  POST /search                 │                               │
    │  {space_id, query, top_k}     │                               │
    │──────────────────────────────▶│                               │
    │                               │                               │
    │                     ┌─────────┴─────────┐                     │
    │                     │ Auth (KV)  ~5ms   │                     │
    │                     │ Space access check│                     │
    │                     └─────────┬─────────┘                     │
    │                               │                               │
    │                               │  Embed query (OpenAI)         │
    │                               │──────────────────────────────▶│
    │                               │◀────────────────── ~100ms ────│
    │                               │                               │
    │                     ┌─────────┴─────────┐                     │
    │                     │ Parallel queries  │                     │
    │                     │ Promise.all([     │                     │
    │                     │   semantic,       │──▶ HNSW ~30ms       │
    │                     │   keyword,        │──▶ GIN  ~20ms       │
    │                     │   graph           │──▶ BFS  ~50ms       │
    │                     │ ])                │                     │
    │                     └─────────┬─────────┘                     │
    │                               │  Max: ~50ms (parallel)        │
    │                               │                               │
    │                     ┌─────────┴─────────┐                     │
    │                     │ RRF Fusion ~2ms   │                     │
    │                     └─────────┬─────────┘                     │
    │                               │                               │
    │                               │  Rerank (ZeroEntropy)         │
    │                               │──────────────────────────────▶│
    │                               │◀────────────────── ~200ms ────│
    │                               │                               │
    │                     ┌─────────┴─────────┐                     │
    │                     │ Recency boost ~1ms│                     │
    │                     └─────────┬─────────┘                     │
    │                               │                               │
    │◀──────────────────────────────│                               │
    │  200 OK [{memories}]          │                               │

Total latency: ~360ms (p50), ~500ms (p95)
```

**Latency breakdown:**
| Step | Time | Notes |
|------|------|-------|
| Auth | ~5ms | KV cache hit |
| Query embedding | ~100ms | OpenAI API |
| Semantic search | ~30ms | pgvector HNSW |
| Keyword search | ~20ms | GIN + ts_rank_cd |
| Graph traversal | ~50ms | BFS, 2 hops max |
| **DB total** | **~50ms** | Parallel, take max |
| RRF fusion | ~2ms | CPU only |
| Reranker | ~200ms | ZeroEntropy API |
| Recency boost | ~1ms | CPU only |
| **Total** | **~360ms** | |

**Optimization levers:**
- Skip reranker for low-stakes queries → saves 200ms
- Cache embeddings for repeated queries → saves 100ms
- Pre-warm graph seeds → saves ~20ms

---

### Flow 3: Ingestion (Source Upload)

```
Agent/Client               API Gateway              CF Queue           Ingestion Worker
    │                          │                       │                      │
    │  POST /sources           │                       │                      │
    │  {space_id, sources[]}   │                       │                      │
    │─────────────────────────▶│                       │                      │
    │                          │                       │                      │
    │                ┌─────────┴─────────┐             │                      │
    │                │ Auth (KV)  ~5ms   │             │                      │
    │                │ Quota check ~20ms │             │                      │
    │                │ Insert sources    │             │                      │
    │                │ (pending) ~30ms   │             │                      │
    │                └─────────┬─────────┘             │                      │
    │                          │                       │                      │
    │                          │  Enqueue job          │                      │
    │                          │──────────────────────▶│                      │
    │                          │                       │                      │
    │◀─────────────────────────│                       │                      │
    │  202 Accepted            │                       │                      │
    │  {job_id, status: queue} │                       │                      │
    │                          │                       │                      │
    │                          │                       │  Dequeue             │
    │                          │                       │─────────────────────▶│
    │                          │                       │                      │
    │                          │                       │            ┌─────────┴─────────┐
    │                          │                       │            │ Memory extraction │
    │                          │                       │            │ (LLM) ~3-5s       │
    │                          │                       │            └─────────┬─────────┘
    │                          │                       │                      │
    │                          │                       │            ┌─────────┴─────────┐
    │                          │                       │            │ Batch embed       │
    │                          │                       │            │ (OpenAI) ~1-2s    │
    │                          │                       │            └─────────┬─────────┘
    │                          │                       │                      │
    │                          │                       │            ┌─────────┴─────────┐
    │                          │                       │            │ Entity resolution │
    │                          │                       │            │ (DB + fuzzy) ~2s  │
    │                          │                       │            └─────────┬─────────┘
    │                          │                       │                      │
    │                          │                       │            ┌─────────┴─────────┐
    │                          │                       │            │ Edge creation     │
    │                          │                       │            │ (DB) ~1s          │
    │                          │                       │            └─────────┬─────────┘
    │                          │                       │                      │
    │                          │                       │            ┌─────────┴─────────┐
    │                          │                       │            │ Update status     │
    │                          │                       │            │ → complete        │
    │                          │                       │            └───────────────────┘

Sync response: ~55ms (enqueue only)
Async processing: 10-20s (background)
```

**Client-facing latency:** ~55ms (just auth + enqueue)

**Background processing breakdown:**
| Step | Time | Notes |
|------|------|-------|
| Memory extraction | 3-5s | LLM via OpenRouter |
| Batch embedding | 1-2s | OpenAI API |
| Entity resolution | ~2s | DB + rapidfuzz |
| Edge creation | ~1s | DB batch insert |
| **Total** | **7-10s** | Per batch of 4 sources |

**Chunking strategy for Workers:**
- Max 4 sources per queue message
- Larger uploads → multiple queue messages
- Each message processes independently

---

### Flow 4: OAuth Login

```
User Browser               API Gateway                Google OAuth
    │                          │                           │
    │  GET /auth/oauth/google  │                           │
    │  /authorize              │                           │
    │─────────────────────────▶│                           │
    │                          │                           │
    │                          │  Build OAuth URL          │
    │                          │  (state + PKCE)           │
    │                          │                           │
    │◀─────────────────────────│                           │
    │  302 Redirect            │                           │
    │  → accounts.google.com   │                           │
    │                          │                           │
    │─────────────────────────────────────────────────────▶│
    │                          │                           │
    │◀─────────────────────────────────────────────────────│
    │  302 Redirect            │                           │
    │  → /auth/oauth/google    │                           │
    │    /callback?code=xxx    │                           │
    │                          │                           │
    │  GET /callback?code=xxx  │                           │
    │─────────────────────────▶│                           │
    │                          │                           │
    │                          │  Exchange code            │
    │                          │──────────────────────────▶│
    │                          │◀─────────────────────────│
    │                          │  {access_token, profile}  │
    │                          │                           │
    │                ┌─────────┴─────────┐                 │
    │                │ Get/create user   │                 │
    │                │ Get/create org    │                 │
    │                │ Create space      │                 │
    │                │ Mint JWT pair     │                 │
    │                └─────────┬─────────┘                 │
    │                          │                           │
    │◀─────────────────────────│                           │
    │  200 OK                  │                           │
    │  {access_token,          │                           │
    │   refresh_token}         │                           │

Total latency: ~500ms (Google OAuth is the bottleneck)
```

---

### Flow 5: API Key Validation (Detailed)

```
Request                     API Gateway                KV Store              NeonDB
    │                           │                          │                    │
    │  Authorization:           │                          │                    │
    │  Bearer csk_abc123...     │                          │                    │
    │──────────────────────────▶│                          │                    │
    │                           │                          │                    │
    │                 ┌─────────┴─────────┐                │                    │
    │                 │ hash = SHA256(key)│                │                    │
    │                 │ ~0.1ms CPU        │                │                    │
    │                 └─────────┬─────────┘                │                    │
    │                           │                          │                    │
    │                           │  GET apikey:{hash}       │                    │
    │                           │─────────────────────────▶│                    │
    │                           │                          │                    │
    │                           │◀─────────────────────────│                    │
    │                           │  ~5ms                    │                    │
    │                           │                          │                    │
    │                 ┌─────────┴─────────┐                │                    │
    │                 │ Cache hit?        │                │                    │
    │                 └────┬─────────┬────┘                │                    │
    │                 Yes  │         │  No                 │                    │
    │                      │         │                     │                    │
    │                      ▼         │                     │                    │
    │               Return cached    │                     │                    │
    │               {user_id,        │  SELECT * FROM api_keys                 │
    │                org_id,         │  WHERE key_hash = ?  │                   │
    │                scopes}         │─────────────────────────────────────────▶│
    │                      │         │                     │                    │
    │                      │         │◀────────────────────────────────────────│
    │                      │         │  ~30ms              │                    │
    │                      │         │                     │                    │
    │                      │         │  PUT apikey:{hash}  │                    │
    │                      │         │  TTL: 5min          │                    │
    │                      │         │─────────────────────▶│                   │
    │                      │         │                     │                    │
    │                      ▼         ▼                     │                    │
    │◀──────────────────────────────│                      │                    │
    │  Proceed with request         │                      │                    │

Cache hit: ~5ms
Cache miss: ~35ms (then cached for 5min)
```

**KV cache schema:**
```typescript
// Key: apikey:${sha256(rawKey)}
interface CachedApiKey {
  user_id: number;
  org_id: number;
  expires_at: number | null;  // unix timestamp
  cached_at: number;
}
```

**Revocation handling:**
- On `DELETE /auth/keys/{id}`: immediately delete from KV
- Worst case: 5-min stale window if KV delete fails

---

## Service Boundaries Summary

| Service | Responsibilities | Runtime |
|---------|-----------------|---------|
| **API Gateway** | Auth, routing, webhooks, billing, sync endpoints | CF Worker |
| **Ingestion Worker** | Queue consumer, LLM extraction, embedding, entity resolution | CF Worker |
| **NeonDB** | All persistent storage, vector search, fulltext | Managed Postgres |
| **KV Store** | API key cache, rate limit counters | Cloudflare KV |
| **Queues** | Ingestion job dispatch | Cloudflare Queues |

---

## Monorepo Structure

```
crosmos-workers/
├── apps/
│   ├── api/                    # API Gateway Worker
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── sources.ts
│   │   │   │   ├── search.ts
│   │   │   │   ├── spaces.ts
│   │   │   │   ├── billing.ts
│   │   │   │   └── webhooks.ts
│   │   │   └── middleware/
│   │   │       ├── auth.ts
│   │   │       └── org.ts
│   │   └── wrangler.toml
│   │
│   └── ingestion/              # Queue Consumer Worker
│       ├── src/
│       │   ├── index.ts
│       │   └── pipeline/
│       │       ├── extract.ts
│       │       ├── embed.ts
│       │       ├── resolve.ts
│       │       └── edges.ts
│       └── wrangler.toml
│
├── packages/
│   ├── db/                     # Drizzle schema
│   ├── auth/                   # JWT + API key utils
│   ├── ai/                     # OpenAI, OpenRouter, ZeroEntropy
│   └── types/                  # Shared Zod schemas
│
├── turbo.json
└── package.json
```

---

## Migration Phases

### Phase 1: Foundation (Week 1-2)
- [ ] Turborepo setup
- [ ] Drizzle schema from existing SQLAlchemy models
- [ ] Hyperdrive binding
- [ ] Basic Hono app with health check

### Phase 2: Auth (Week 2-3)
- [ ] JWT utilities
- [ ] API key validation + KV cache
- [ ] OAuth flow
- [ ] Auth middleware

### Phase 3: Retrieval (Week 3-4)
- [ ] Semantic search (pgvector)
- [ ] Keyword search (GIN)
- [ ] Graph traversal
- [ ] RRF fusion + ZeroEntropy reranker
- [ ] `POST /search` endpoint

### Phase 4: Ingestion (Week 4-5)
- [ ] Cloudflare Queue setup
- [ ] Memory extraction
- [ ] Embedding + entity resolution
- [ ] Edge creation
- [ ] `POST /sources` endpoint

### Phase 5: Billing (Week 5-6)
- [ ] Polar webhook handler
- [ ] Billing routes

### Phase 6: Testing & Cutover (Week 6-7)
- [ ] E2E tests
- [ ] Performance benchmarks
- [ ] DNS switch

---

## Key Python Files to Reference

| Purpose | File |
|---------|------|
| Auth middleware | `app/api/auth/dependencies.py` |
| API key hashing | `app/services/auth/service.py` |
| Ingestion pipeline | `app/engine/ingestion/pipeline.py` |
| Memory extraction | `app/engine/extractors/memories.py` |
| Entity resolution | `app/engine/extractors/resolve_entity.py` |
| Retrieval service | `app/engine/retrieval/service.py` |
| Semantic search | `app/engine/retrieval/semantic.py` |
| Keyword search | `app/engine/retrieval/keyword.py` |
| Graph traversal | `app/engine/retrieval/graph.py` |
| Polar webhook | `app/api/webhooks/polar.py` |
