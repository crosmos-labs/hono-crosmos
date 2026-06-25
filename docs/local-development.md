# Local Development & Memory Benchmarks

Runs the full retrieval/ingestion stack on your machine with **no Cloudflare
AI or Vectorize**, so you can benchmark memory retrieval locally and
repeatably. The only outbound dependency is the OpenRouter API (embeddings +
the extraction LLM over HTTP).

## What runs where

| Concern | Local backend | How it's selected |
|---|---|---|
| Relational + vector DB | Postgres 17 + **pgvector** (docker, `:5433`) | `pgvector/pgvector:pg17` in `docker-compose.yml`; reached via Hyperdrive `localConnectionString` |
| Vector store | `PgVectorStore` (pgvector columns on `memories`/`entities`) | `VECTOR_STORE=pg` |
| Embeddings | OpenRouter `openai/text-embedding-3-small` @ 1024-dim (HTTP) | `EMBEDDINGS_PROVIDER=openrouter` |
| Extraction LLM (ingestion) | OpenRouter (HTTP) | `LLM_PROVIDER=openrouter` |
| Reranker | **on** — ZeroEntropy `zerank-2` (HTTP) | `RETRIEVAL_RERANKER_ENABLED=true` (default), `RERANKER_PROVIDER=zeroentropy` |
| KV / Queues / Durable Objects | Miniflare (emulated locally) | automatic under `wrangler dev` |

The vector store, embedder, and reranker are all already abstracted behind
ports (`packages/vector`, `packages/ai`), so this is pure configuration — no
code changes. Flip the env vars back (or just remove the local block from
`.dev.vars`) to return to the Cloudflare path.

> **Embedding-space invariant:** the API worker and the ingestion worker MUST
> use the same `EMBEDDINGS_PROVIDER` (and dimension). Document vectors written
> by ingestion and query vectors embedded by search have to live in one space,
> or retrieval silently breaks. `assertEmbeddingSpace` in `@crosmos/ai` guards
> the dimension (1024).

## One-time setup

1. Copy the env examples and fill in your OpenRouter key:

   ```sh
   cp apps/api/.dev.vars.example       apps/api/.dev.vars
   cp apps/ingestion/.dev.vars.example apps/ingestion/.dev.vars
   ```

   In **both** `.dev.vars`, uncomment the "Fully-local benchmark path" block and
   set `OPENROUTER_API_KEY`. (The committed `.dev.vars` already include this
   block — just replace `sk-or-v1-REPLACE_ME`.)

2. Install deps and bring up the stack (Postgres + migrations):

   ```sh
   bun install
   ./scripts/dev-setup.sh
   ```

   The script starts the pgvector container, waits for it to be healthy, applies
   the Drizzle migrations (which run `CREATE EXTENSION vector`), and verifies the
   extension is present.

## Run the workers

Both workers in **one command** from the repo root (`turbo dev` runs every
workspace's `dev` script in parallel — output is prefixed per worker):

```sh
bun run dev   # api :8787 + ingestion :8788, one terminal; Ctrl+C stops both
```

Each worker has a distinct `inspector_port` in its `wrangler.toml`
(api `9229`, ingestion `9230`) — wrangler defaults every worker to `9229`, so
without that they'd collide and the second worker would die with
`Address already in use (127.0.0.1:9229)`.

Or run them individually in separate terminals if you prefer isolated logs:

```sh
bun --filter @crosmos/api       dev   # http://localhost:8787
bun --filter @crosmos/ingestion dev   # http://localhost:8788
```

The API → ingestion fast path (service binding) needs both up. Smoke check:
`curl http://localhost:8787/health`, then `/docs` and `/openapi.json`.

## Running a benchmark

Search and ingestion require valid auth, a memory space, and the OpenRouter key
above. With those in place, the retrieval path runs entirely against local
pgvector — embedding cost is the only network/$ factor. The `bench:compare`
script (`apps/api/package.json`, `scripts/benchmark-compare.ts`, see
`docs/benchmark-compare.md`) is the entry point for comparing runs.

## Notes & gotchas

- **Migrations need a direct URL.** `drizzle-kit` connects directly, not through
  Hyperdrive: `DATABASE_URL=postgresql://crosmos:crosmos@localhost:5433/crosmos`.
  `dev-setup.sh` sets this for you.
- **Reranker.** ON by default and should stay on — it's part of retrieval
  quality, not an optional add-on. Locally it runs over HTTP via
  `RERANKER_PROVIDER=zeroentropy` + `ZEROENTROPY_API_KEY` (set in
  `apps/api/.dev.vars`), mirroring the HTTP embedder. Alternatively drop those
  two lines to run it through Cloudflare Workers AI (hits remote CF). Only set
  `RETRIEVAL_RERANKER_ENABLED=false` if you explicitly want to measure
  pre-rerank ranking in isolation.
- **Vectorize/AI bindings are still declared** in `wrangler.toml`, but with
  `VECTOR_STORE=pg`, `EMBEDDINGS_PROVIDER=openrouter`, and
  `RERANKER_PROVIDER=zeroentropy`, no code path touches them, so `wrangler dev`
  never reaches out to Cloudflare. (The `AI` binding *would* be used if you
  switch the reranker back to the default `workers-ai` provider — that path hits
  remote CF. The reranker stays on either way.)
- **Resetting data:** `docker compose down -v` drops the `crosmos_pgdata` volume;
  re-run `./scripts/dev-setup.sh` to recreate a clean schema.
