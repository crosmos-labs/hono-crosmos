# Crosmos Workers Docs

This repo is the TypeScript/Hono Cloudflare Workers implementation of Crosmos memory APIs. The old migration specs were removed after the core migration work landed; these files are the compact durable context for future sessions.

Read only the doc that matches the task:

| File | Use it for |
|---|---|
| [stack-and-practices.md](./stack-and-practices.md) | Tooling, coding conventions, runtime constraints |
| [deployed-architecture.md](./deployed-architecture.md) | Cloudflare Workers, bindings, domains, deploy commands |
| [code-architecture.md](./code-architecture.md) | Monorepo layout, app/package boundaries, route ownership |
| [pipelines.md](./pipelines.md) | Ingestion, conversation ingestion, retrieval/search execution |
| [ingestion-retrieval-system-design.md](./ingestion-retrieval-system-design.md) | Current ingestion/retrieval diagrams, risks, and scalable target architecture |
| [ingestion-retrieval-now-vs-after-design.md](./ingestion-retrieval-now-vs-after-design.md) | Easy-to-follow Mermaid diagrams comparing current and proposed ingestion, retrieval, and deletion flows |
| [ingestion-retrieval-priority-checklist-2026-08-10.md](./ingestion-retrieval-priority-checklist-2026-08-10.md) | Canonical, no-regression remediation priorities with incident progress and rationale |
| [operations.md](./operations.md) | Local commands, migrations, secrets, observability |
| [latency-and-storage-options.md](./latency-and-storage-options.md) | Options/exploration (2026-06-09): global latency, where relational/graph/vector stores live, Workers AI, DO-per-space |

Current deployment context:

- `api.crosmos.dev` is the current customer-facing Cloudflare Workers TypeScript/Hono production API deployed from this repository.
- `staginghono.crosmos.dev` is the Hono staging environment.
- The old Python codebase at `../crosmos-mem` is historical/reference code only and is not the current production API.
