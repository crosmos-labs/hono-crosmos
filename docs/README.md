# Crosmos Workers Docs

This repo is the TypeScript/Hono Cloudflare Workers implementation of Crosmos
memory APIs. Start with [the documentation authority order](../.codex/README.md).
Current-state documents and dated historical records are intentionally separate.

Read only the doc that matches the task:

| File | Use it for |
|---|---|
| [../.codex/stack-and-practices.md](../.codex/stack-and-practices.md) | Tooling, coding conventions, runtime constraints |
| [../.codex/deployed-architecture.md](../.codex/deployed-architecture.md) | Cloudflare Workers, bindings, domains, deploy commands |
| [../.codex/code-architecture.md](../.codex/code-architecture.md) | Monorepo layout, app/package boundaries, route ownership |
| [../.codex/pipelines.md](../.codex/pipelines.md) | Ingestion, conversation ingestion, retrieval/search execution |
| [../.codex/operations.md](../.codex/operations.md) | Local commands, migrations, secrets, observability |
| [ingestion-retrieval-system-design.md](./ingestion-retrieval-system-design.md) | **Historical:** 2026-08-10 review; resolved findings are not current defects |
| [ingestion-retrieval-now-vs-after-design.md](./ingestion-retrieval-now-vs-after-design.md) | **Historical:** diagrams captured during the 2026-08-10 review |
| [ingestion-retrieval-priority-checklist-2026-08-10.md](./ingestion-retrieval-priority-checklist-2026-08-10.md) | **Historical:** remediation checklist and rationale |
| [latency-optimization-opportunity-audit-2026-08-11.md](./latency-optimization-opportunity-audit-2026-08-11.md) | Ranked latency opportunities for retrieval and ingestion, with an accuracy gate |
| [retrieval-latency-budget-2026-08-17.md](./retrieval-latency-budget-2026-08-17.md) | **Current** measured retrieval latency budget, where the 683 ms goes, and the ordered plan to reach ~500 ms server-side |
| [observability-admin-analytics-checklist-2026-08-12.md](./observability-admin-analytics-checklist-2026-08-12.md) | Making changes measurable, the admin plane, and user-facing analytics endpoints |
| [metrics-runbook.md](./metrics-runbook.md) | What each Analytics Engine metric means and how to query it |

The `.codex/` documents are the compact current-state LLD. Dated audits,
benchmarks, reviews, and checklists preserve evidence and rationale but do not
override code, executable contracts, production configuration, or the compact
LLD.

Current deployment context:

- `api.crosmos.dev` is the current customer-facing Cloudflare Workers TypeScript/Hono production API deployed from this repository.
- Production is the only supported deployed environment today. Local Wrangler
  defaults and any remaining staging manifests do not imply a working deployed
  development or staging system.
- The old Python codebase at `../crosmos-mem` is historical/reference code only and is not the current production API.
