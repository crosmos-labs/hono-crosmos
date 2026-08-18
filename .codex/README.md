# Documentation Authority

status: current
owner: engineering
last_verified: 2026-08-19
owns: documentation source-of-truth order
does_not_own: runtime behavior, deployment values, or product roadmap

Use this order when two sources disagree:

1. Executable contract tests and database constraints define behavior that is
   mechanically enforced.
2. The production Wrangler environment defines the configuration intended for
   the next production deployment. Confirm the deployed Worker when a rollout
   is in progress.
3. The compact current-state documents in this directory describe boundaries,
   flows, and operating practices.
4. ADRs record non-obvious decisions and incident-derived constraints.
5. Source comments explain only local invariants that the code cannot express.
6. Dated audits, investigations, benchmarks, and checklists are historical
   records. They are not current architecture specifications.

The implementation remains authoritative where prose and code diverge. Update
the relevant compact document in the same change whenever an architectural
boundary, mounted route group, binding, provider selection, or operational
procedure changes.

## Current-state documents

| Document | Authority |
|---|---|
| [stack-and-practices.md](./stack-and-practices.md) | Runtime, tools, code conventions, and invariants |
| [deployed-architecture.md](./deployed-architecture.md) | Worker topology, production provider matrix, bindings, and domains |
| [code-architecture.md](./code-architecture.md) | Application/package boundaries and route ownership |
| [pipelines.md](./pipelines.md) | Current ingestion and retrieval execution flows |
| [operations.md](./operations.md) | Supported local, migration, validation, and deployment procedures |
| [current-problems.md](./current-problems.md) | Current constraints; not an implementation backlog |

