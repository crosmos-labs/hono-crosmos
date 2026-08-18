# Crosmos Workers Docs

This repo is the TypeScript/Hono Cloudflare Workers implementation of Crosmos memory APIs. The old migration specs were removed after the core migration work landed; these files are the compact durable context for future sessions.

Read only the doc that matches the task:

| File | Use it for |
|---|---|
| [../.codex/stack-and-practices.md](../.codex/stack-and-practices.md) | Tooling, coding conventions, runtime constraints |
| [../.codex/deployed-architecture.md](../.codex/deployed-architecture.md) | Cloudflare Workers, bindings, domains, deploy commands |
| [../.codex/code-architecture.md](../.codex/code-architecture.md) | Monorepo layout, app/package boundaries, route ownership |
| [../.codex/pipelines.md](../.codex/pipelines.md) | Ingestion, conversation ingestion, retrieval/search execution |
| [../.codex/operations.md](../.codex/operations.md) | Local commands, migrations, secrets, observability |
| [ingestion-retrieval-system-design.md](./ingestion-retrieval-system-design.md) | Current ingestion/retrieval diagrams, risks, and scalable target architecture |
| [ingestion-retrieval-now-vs-after-design.md](./ingestion-retrieval-now-vs-after-design.md) | Easy-to-follow Mermaid diagrams comparing current and proposed ingestion, retrieval, and deletion flows |
| [ingestion-retrieval-priority-checklist-2026-08-10.md](./ingestion-retrieval-priority-checklist-2026-08-10.md) | Canonical, no-regression remediation priorities with incident progress and rationale |
| [latency-optimization-opportunity-audit-2026-08-11.md](./latency-optimization-opportunity-audit-2026-08-11.md) | Ranked latency opportunities for retrieval and ingestion, with an accuracy gate |
| [retrieval-latency-budget-2026-08-17.md](./retrieval-latency-budget-2026-08-17.md) | **Current** measured retrieval latency budget, where the 683 ms goes, and the ordered plan to reach ~500 ms server-side |
| [observability-admin-analytics-checklist-2026-08-12.md](./observability-admin-analytics-checklist-2026-08-12.md) | Making changes measurable, the admin plane, and user-facing analytics endpoints |
| [metrics-runbook.md](./metrics-runbook.md) | What each Analytics Engine metric means and how to query it |

The first five moved to `.codex/` in commit `89c8458`; the links above point at
their current location. `latency-and-storage-options.md` was deleted with no
replacement.

Current deployment context:

- `api.crosmos.dev` is the current customer-facing Cloudflare Workers TypeScript/Hono production API deployed from this repository.
- `staginghono.crosmos.dev` is the Hono staging environment.
- The old Python codebase at `../crosmos-mem` is historical/reference code only and is not the current production API.
