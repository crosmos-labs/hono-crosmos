# Crosmos Workers Docs

This repo is the TypeScript/Hono Cloudflare Workers implementation of Crosmos memory APIs. The old migration specs were removed after the core migration work landed; these files are the compact durable context for future sessions.

Read only the doc that matches the task:

| File | Use it for |
|---|---|
| [stack-and-practices.md](./stack-and-practices.md) | Tooling, coding conventions, runtime constraints |
| [deployed-architecture.md](./deployed-architecture.md) | Cloudflare Workers, bindings, domains, deploy commands |
| [code-architecture.md](./code-architecture.md) | Monorepo layout, app/package boundaries, route ownership |
| [pipelines.md](./pipelines.md) | Ingestion, conversation ingestion, retrieval/search execution |
| [operations.md](./operations.md) | Local commands, migrations, secrets, observability |
| [latency-and-storage-options.md](./latency-and-storage-options.md) | Options/exploration (2026-06-09): global latency, where relational/graph/vector stores live, Workers AI, DO-per-space |

Current deployment context:

- `hono.crosmos.dev` is the live Cloudflare Workers TypeScript/Hono deployment for ongoing development.
- `api.crosmos.dev` is still the current production Python API.
- The Python codebase lives at `../crosmos-mem` and remains the reference when parity with old behavior is unclear.
