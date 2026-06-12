# Cloudflare Workers AI + Vectorize migration — runbook

Moves embeddings + reranking from OpenAI/ZeroEntropy (HTTP) to **Cloudflare
Workers AI** (binding) and vector storage from **Postgres/pgvector** to
**Cloudflare Vectorize**, both behind swappable ports. See the plan for design.

## What changed (code)

- `@crosmos/ai`: added `WorkersAiEmbedder` (`@cf/baai/bge-m3`, 1024-dim) and
  `WorkersAiReranker` (`@cf/baai/bge-reranker-base`). Both use the `AI` binding.
- New `@crosmos/vector` package: `VectorStore` port + `PgVectorStore` (pgvector)
  and `VectorizeStore` (Vectorize) adapters.
- Provider selection via env (defaults in **bold**):
  - `EMBEDDINGS_PROVIDER` = **`workers-ai`** | `openai`
  - `RERANKER_PROVIDER` = **`workers-ai`** | `zeroentropy`
  - `VECTOR_STORE` = **`vectorize`** | `pg`
- Embedding dimension changed **1536 → 1024** (schema + Vectorize index).
- Retrieval read path (`semantic`, `graph` seeds, `MMR`) and ingestion
  (dedup hint, entity-resolution prefilter, vector writes) all go through the
  `VectorStore` port.

## One-time provisioning (Cloudflare)

You must create the Vectorize indexes before deploying with
`VECTOR_STORE=vectorize`. Bindings are already in both `wrangler.toml` files
(`MEMORIES_INDEX`, `ENTITIES_INDEX`).

```sh
# Dev indexes (used by `wrangler dev` / top-level env)
bunx wrangler vectorize create crosmos-memories-dev --dimensions=1024 --metric=cosine
bunx wrangler vectorize create crosmos-entities-dev --dimensions=1024 --metric=cosine

# Production indexes
bunx wrangler vectorize create crosmos-memories --dimensions=1024 --metric=cosine
bunx wrangler vectorize create crosmos-entities --dimensions=1024 --metric=cosine
```

Tenant isolation uses a **per-space namespace** (`space:{spaceId}`), so metadata
indexes are not required for queries. (`orgId`/`spaceId` are stored in metadata
for debugging; add metadata indexes only if you later want to filter on them.)

Workers AI needs no provisioning — the `[ai]` binding is enough. The account
must have Workers AI + Vectorize enabled (Workers Paid plan).

## Database migration

Dimension change is destructive (existing vectors are dropped; data is
disposable per the plan). Migration `0003_bge_m3_1024_dims.sql` resizes the
columns to `vector(1024)`.

> Note: the migration journal was out of sync (file `0002` existed but wasn't in
> `_journal.json`). It now lists `0002` + `0003`; both are idempotent
> (`IF NOT EXISTS` / drop+recreate). On a fresh/disposable DB just run migrate.

```sh
DATABASE_URL=<direct-postgres-url> bun run db:migrate
```

After migrating, **re-ingest** so memories/entities get bge-m3 vectors written
to Vectorize (and the PG `embedding` column stays null under `VECTOR_STORE=vectorize`).

## Deploy

```sh
bun run typecheck
bunx wrangler deploy --env production   # run in apps/api and apps/ingestion
```

## Reverting / experimenting

Flip providers independently via the `*_PROVIDER` / `VECTOR_STORE` vars (in
`wrangler.toml` `[vars]` / `[env.production.vars]`, or per `wrangler dev`):

- Back to the old stack: `EMBEDDINGS_PROVIDER=openai`,
  `RERANKER_PROVIDER=zeroentropy`, `VECTOR_STORE=pg` — and set `OPENAI_API_KEY`
  / `ZEROENTROPY_API_KEY` secrets. The embedding **dimension must match the
  stored vectors**: OpenAI is 1536, so going back to `openai` requires a 1536
  schema and a re-ingest (it is not a hot toggle on the same data).
- The reranker can be flipped freely (no stored state).
- `VECTOR_STORE=pg` requires the `embedding` columns to be populated, i.e.
  ingest while `pg` is active.

## Notes / caveats

- **Graph seeding** (`seedByMemory` / `seedByEntityEmbedding`) is now ANN via the
  vector store. Under Vectorize this is approximate top-K (vs. the exact
  in-memory cosine of the pg path) — accepted for the latency win.
- **Visibility**: Vectorize can't express the per-user OR filter, so the semantic
  + graph signals enforce visibility by intersecting ANN hits with the
  already-loaded visible working set (`candidates.ts`).
- **Eventual consistency**: Vectorize upserts are queryable "within seconds" —
  fine for ingest→later retrieval, not for read-your-write immediately after
  ingest in tests.
- **Score semantics**: adapters return cosine **similarity** (higher = better).
  If Vectorize results look inverted, confirm the index `--metric=cosine` and
  the score handling in `packages/vector/src/vectorize.ts`.
- **Tuning**: `SEMANTIC_MIN_SCORE` / `GRAPH_SEED_THRESHOLD` were tuned for
  OpenAI cosine; revisit after measuring bge-m3 results.
```
