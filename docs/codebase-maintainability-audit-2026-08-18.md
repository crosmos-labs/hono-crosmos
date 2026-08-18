# Crosmos Hono Codebase Maintainability Audit

**Date:** 2026-08-18  
**Scope:** repository-wide code quality, structure, architecture, patterns, LLD accuracy, comments, docstrings, and dead/stale code  
**Constraint:** sanitation and maintainability only; no feature work, no ranking changes, no wire-contract changes, and no intentional runtime behavior changes

## Executive summary

The codebase has a sound production core. Tenant scoping, provider ports, queue durability, deterministic retrieval tests, structured observability, and explicit production manifests are all stronger than is typical for a codebase of this age. The normal repository baseline is green: workspace typechecking, the full Turbo test task, and all three Worker dry-run builds pass.

The main maintainability problem is not fundamentally bad architecture. It is **drift between several partially authoritative descriptions of the architecture**, plus implementation history accumulating inside source comments. The repository currently has all of these competing as sources of truth:

1. live TypeScript code;
2. three large Wrangler manifests;
3. compact `.codex` architecture notes;
4. a 910-line LLD/system-design document;
5. several dated checklists totaling thousands of lines;
6. long incident narratives and Python-parity notes embedded in production source.

Those sources now contradict one another. The LLD dated 2026-08-10 still presents already-fixed problems as current even though 154 commits have landed since it was last updated. The compact architecture files describe an older queue-only, KV-concurrency, Smart Placement, pre-Qdrant shape. Source comments still describe OpenAI embeddings as pinned to 1024 dimensions and the API Worker as Singapore-placed, while production is explicitly OpenAI `text-embedding-3-small` at 1536 dimensions, Qdrant, targeted `aws:us-east-1`, and ZeroEntropy `zerank-2` with reranking enabled.

The recommended cleanup is therefore:

1. handle the tracked credential file immediately;
2. establish one documentation hierarchy and rewrite the compact LLD from live code/config;
3. add missing quality gates so dead imports, test type errors, dependency cycles, and boundary drift cannot return;
4. perform a mechanical dead-code/comment cleanup;
5. then decompose the largest orchestration modules behind characterization tests.

## Current production truth used by this audit

This audit treats code and the production Wrangler blocks as authoritative.

| Concern | Current production setting |
|---|---|
| Public API | TypeScript/Hono Worker at `api.crosmos.dev` |
| Embeddings | OpenAI `text-embedding-3-small`, 1536 dimensions |
| Vector store | Qdrant |
| Reranker | ZeroEntropy `zerank-2`, enabled |
| Reranker migration | Voyage adapter exists; migration/evaluation is ongoing, not yet the production default |
| Extraction LLM | OpenAI, currently `gpt-4.1-mini` in the adapter |
| Ingestion dispatch | Durable Queue copy plus service-binding RPC fast path, coordinated by a Postgres claim |
| Search concurrency/rate limiting | Durable Object primary path; KV/no-op implementations are fallbacks |
| Placement | Targeted `aws:us-east-1`, not Smart Placement |
| Source of record | Neon Postgres through Hyperdrive; Qdrant is a derived ANN index |

Evidence: `apps/api/wrangler.toml:198-208`, `apps/api/wrangler.toml:245-256`, `apps/ingestion/wrangler.toml:154-174`, and `packages/ai/src/reranker/zeroentropy.ts:18`.

## What the codebase is doing well

- **Ports and adapters are real, not decorative.** Embeddings, reranking, vector storage, queues, rate limiting, cache, email, background work, and job storage have useful seams. OpenRouter, Workers AI, Vectorize, pgvector, and Voyage are legitimate reversible adapters and should not be removed merely because they are not the current production selection.
- **Tenant boundaries are explicit.** `TenantScope` and the scope helpers make the intended org-plus-space invariant visible. External ANN results are hydrated through Postgres instead of being trusted directly.
- **Durability logic is thoughtfully tested.** Atomic job claims, continuation messages, retry classification, checkpointed ingestion, purge recovery, tombstones, and vector-write recovery have focused tests.
- **Retrieval has characterization tests.** Differential tests and the fixture-backed pipeline baseline are exactly what make behavior-preserving cleanup feasible.
- **The code is strict TypeScript.** `strict` and `noUncheckedIndexedAccess` are enabled, and production code has very little unsafe `any` usage.
- **Observability has a privacy boundary.** The structured log allowlist is a useful defense against accidentally logging user content, and metrics/traces carry bounded dimensions.
- **Production configuration is explicit.** Staging and production provider selections are not inferred from accidental defaults.
- **Package direction is mostly sensible.** Core packages do not depend on apps, and application code generally consumes package entrypoints instead of reaching into package internals.

These strengths should be preserved during cleanup. In particular, avoid a large rewrite or a new framework/layer stack; the code needs sharper boundaries and less historical residue, not a new architecture.

## Repository observations

| Observation | Result |
|---|---:|
| Tracked TypeScript files across apps, packages, tests, and scripts | 266 |
| Tracked TypeScript lines | 42,528 |
| Production `src` lines | 31,288 across 202 files |
| Production comment-token lines | about 3,970 (12.6%) |
| Comments/docblocks at least 8 lines long | 213 across the repository |
| Production functions at least 80 lines long | multiple; the largest are 578, 570, 553, and 524 lines |
| API route-module lines | 6,381 |
| Direct query-builder calls in API route files | 39 |
| Local import cycles | 1 (`@crosmos/db` barrel/usage rollup) |
| Normal workspace typecheck | passes |
| Normal workspace test task | passes |
| Worker dry-run builds | pass, with an environment-selection warning |
| Standalone test typecheck | fails in `@crosmos/ai` Voyage tests |
| CI/lint/formatter/dead-code configuration | absent |

The raw comment percentage is not itself a target. Port contracts, safety invariants, ranking formulas, and queue state transitions deserve comments. The problem is that many comments describe history, old incidents, old Python paths, provider defaults, or missing documents rather than stable behavior.

## Priority 0: immediate repository hygiene

### [x] SEC-1 — Rotate and remove the tracked benchmark credentials

Completed before this sanitation pass. The tracked credential file was removed
in commit `f660508`; credential rotation was confirmed by the repository owner.

**Finding**

`.bench.env` is tracked and contains non-placeholder Crosmos and OpenAI credentials. The values were not copied into this audit.

**Why this is urgent**

Deleting the file in a future commit is insufficient if the credentials remain valid or remain in Git history.

**Actions**

- Rotate/revoke the Crosmos benchmark API key and OpenAI key first.
- Remove `.bench.env` from tracking and history using the repository's approved history-rewrite process.
- Add `.bench.env` to `.gitignore` and commit a `.bench.env.example` containing names and safe placeholders only.
- Run a full-history secret scan and inspect CI artifacts, forks, and remote caches.
- Add secret scanning to CI and, if the hosting platform supports it, enable push protection.

**Acceptance criteria**

- No working credential exists anywhere in reachable Git history.
- A fresh clone has no benchmark secret but clearly documents the required variable names.
- CI rejects a seeded fake-secret fixture.

## Priority 1: make architecture and quality gates trustworthy

### [x] DOC-1 — Define an explicit source-of-truth hierarchy

Completed 2026-08-19. `.codex/README.md` now defines the authority order and
every compact current-state document declares its ownership and limits.

**Finding**

The current code, Wrangler comments, `.codex` notes, system-design LLD, dated checklists, and source comments all claim architectural authority.

**Actions**

Adopt this hierarchy:

1. executable contract tests and database constraints;
2. production Wrangler configuration for deployed provider/binding selection;
3. a compact current-state LLD for component boundaries and flows;
4. ADRs for non-obvious decisions and incident-derived constraints;
5. source comments for local invariants only;
6. dated investigations/checklists as historical records, never current truth.

Add `owner`, `status`, and `last_verified` metadata to durable architecture documents. A dated investigation should say `historical` at the top and link to the durable document that supersedes it.

**Acceptance criteria**

- Every durable document states what it owns and what it does not own.
- No two documents both claim to be the current architecture source.
- A reviewer can identify the production provider matrix without reading source comments.

### [x] DOC-2 — Rewrite the compact LLD from current code/config

Completed 2026-08-19. The compact LLD now covers all three Workers, all seven
shared packages, every mounted API route group, current bindings, Queue + RPC
coordination, Qdrant, Durable Objects, observability, and the live pipeline.

**Finding**

The compact `.codex` files are materially stale:

- `.codex/code-architecture.md:5-14` omits `apps/admin` and the runtime, observability, vector, and test-support packages.
- `.codex/code-architecture.md:20-45` omits analytics, billing, entities, graph, memories, usage, visibility, maintenance, webhooks, the Durable Object, and the service-binding path.
- `.codex/code-architecture.md:75-78` omits chunks, visibility, billing, and audit tables and still names `source_memories`, while the live junction is `chunk_memories`.
- `.codex/deployed-architecture.md:18-35` omits Qdrant, the RPC fast path, Analytics Engine, tracing exports, and Durable Object rate/concurrency limiting.
- `.codex/deployed-architecture.md:45` says Smart Placement; production uses targeted US East placement.
- `.codex/pipelines.md:27` says conversations are split into multiple sources by the API. Current code stores one source and chunks it in ingestion.
- `.codex/pipelines.md:66-68` says KV concurrency and a 30-second timeout. The primary limiter is a Durable Object and the default timeout is 6 seconds.
- `.codex/stack-and-practices.md:9-13,41` describes pgvector/KV-oriented deployment details that no longer describe production.
- `.codex/operations.md` lists `ZEROENTROPY_API_KEY` for ingestion even though ingestion does not rerank.

**Actions**

- Rewrite the component map for three workers and seven shared packages.
- Replace prose provider claims with a small environment matrix sourced from Wrangler.
- Document Queue + RPC claim coordination and continuation messages.
- Document Qdrant as derived storage, Durable Objects as the primary hot-path limiter, and KV as cache/fallback.
- Document the current conversation chunking and retrieval sequence.
- Remove line-number-heavy details that will immediately drift; link to stable module names and tests instead.

**Acceptance criteria**

- Every mounted route group in `apps/api/src/index.ts` is represented.
- Every production binding/provider in all three Wrangler files is represented.
- The LLD agrees with the production matrix at the top of this audit.

### [x] DOC-3 — Stop treating the 2026-08-10 system-design review as current

Completed 2026-08-19. The review is explicitly historical, links to the durable
LLD, and distinguishes resolved findings from the remaining product concerns.

**Finding**

`docs/ingestion-retrieval-system-design.md` calls itself the current architecture source, but many high-priority findings in it have already been implemented:

- resumed-batch purge scoping;
- continuation messages separated from failure retries;
- cancellation propagation;
- speaker-role persistence;
- source-content loading after final selection;
- SQL-side graph bounds;
- observability/Analytics Engine activation.

The file has not been updated since commit `89c8458`; 154 commits followed it by the audit date. Some findings remain relevant, such as ANN visibility recall starvation, but the document does not distinguish resolved from unresolved work.

**Actions**

- Either convert it into a historical review with a resolution table, or rewrite it as the current LLD. Do not leave it in between.
- Move unresolved product/feature recommendations into the appropriate roadmap. They are explicitly out of scope for this sanitation effort.
- Add a short `superseded_by` link from dated diagrams/checklists to the durable current-state LLD.

**Acceptance criteria**

- Resolved findings cannot be mistaken for current production defects.
- Historical rationale remains available without being copied into production comments.

### [ ] TOOL-1 — Add CI with one canonical quality command

**Finding**

There is no checked-in CI configuration, formatter, linter, dead-code checker, or architecture-boundary rule.

**Actions**

Create a root `check` task that runs, in this order:

1. formatting check;
2. lint;
3. production typecheck;
4. test typecheck;
5. dead-code/dependency check;
6. unit/integration tests;
7. Worker dry-run builds for explicit environments;
8. migration/schema consistency checks;
9. local Markdown link check and secret scan.

Use the same command locally and in CI. Do not hide warnings in a successful task.

**Acceptance criteria**

- A fresh clone can run one documented command and reproduce CI.
- CI fails on an unused import, a test-only type error, a missing migration snapshot, and a package-boundary violation.

### [ ] TOOL-2 — Turn unused-code checking into a gate

**Finding**

`noUnusedLocals`/`noUnusedParameters` are not enabled. Running TypeScript with them finds real residue:

- stale `OpenAPIHono` imports across most route files after adoption of `createApiApp`;
- stale `HonoEnv` imports in several route modules;
- `lt` and `sql` in `features/analytics/service.ts`;
- `TemporalRange` in search service;
- `BACKSTOP_RETRY_DELAY_SECONDS` in `process-ingestion.ts`;
- `memorySpaces` in `packages/db/src/schema/daily-usage.ts`;
- unused private `getOrCreateEntity()` in entity resolution.

TypeScript does not identify unused exports, so also add an export/file/dependency checker with an explicit ignore list for Worker entrypoints, Durable Object exports, provider adapters, scripts, and test fixtures.

**Acceptance criteria**

- Production compiles with unused locals/parameters enabled.
- Unused-export tooling has a reviewed configuration, not a blanket ignore.
- Provider adapters are retained intentionally and are not repeatedly reported as unexplained dead code.

### [ ] TEST-1 — Include test TypeScript in the root typecheck

**Finding**

The apps and some packages define `typecheck:test`, but Turbo's root `typecheck` only invokes `typecheck`. The normal green typecheck therefore excludes tests. `@crosmos/ai`'s standalone test typecheck currently fails in `tests/voyage-reranker.test.ts:34,75,86` even though runtime tests pass.

`@crosmos/observability` has tests but no test tsconfig/typecheck script.

**Actions**

- Add a Turbo `typecheck:test` task or fold tests into each package's canonical typecheck.
- Add test typechecking to observability and any package that acquires tests later.
- Fix the Voyage test mock/body inference errors without weakening production types.

**Acceptance criteria**

- The root quality command typechecks every test file.
- Removing or changing an interface used only by tests cannot leave CI green with invalid test TypeScript.

### [x] CFG-1 — Add an executable deployment-config consistency test

Completed 2026-08-19. The TOML-backed contract test asserts the production
provider/vector space, Qdrant collections, queues, service binding, Hyperdrive,
placement, and retained rollback indexes across the API and ingestion Workers.

**Finding**

The most dangerous cross-worker invariant—embedding provider/model/dimensions and vector-store alignment—is duplicated in comments and two Wrangler files. The comments have already drifted.

**Actions**

Add a small test that parses the API and ingestion Wrangler files and asserts, per environment:

- the embedding provider and dimensions match;
- the vector backend and Qdrant URL/collection selection match where required;
- production reranking is enabled and has an allowed provider;
- the API service binding points to the corresponding ingestion environment;
- queue producer/consumer names match;
- staging does not reuse production data resources.

The test should describe current production (`openai`, 1536, `qdrant`, `zeroentropy`, enabled) without embedding secrets.

**Acceptance criteria**

- A one-sided provider/dimension change fails before deployment.
- Voyage can be promoted by one intentional, reviewed config change and associated expectation update.

### [x] CFG-2 — Parse environment configuration once into typed, validated config

Completed 2026-08-19. Shared strict parsers and per-Worker cached config readers
now produce typed provider selections and validated numeric/boolean settings.
The deployment-environment type includes staging without pretending a staged
deployment is currently provisioned.

**Finding**

Raw environment strings are parsed ad hoc in embedding factories, operational limits, cleanup retention, billing reconciliation, admin pagination, and benchmark scripts. Provider selection plus required bindings/secrets is expressed through large optional `Env` interfaces rather than validated discriminated configurations.

The API and ingestion `ENVIRONMENT` types allow only `development | production`, while both Wrangler files deploy `ENVIRONMENT = "staging"`.

**Actions**

- Introduce a shared `DeploymentEnvironment = 'development' | 'staging' | 'production'` type.
- Build small per-worker config readers that validate provider-specific requirements and numeric ranges once.
- Return discriminated provider configurations, for example a Qdrant selection that necessarily includes URL/key/collection names.
- Keep Cloudflare binding types at the entrypoint; pass validated application config inward.
- Do not turn ranking constants into env vars as part of this work.

**Acceptance criteria**

- Invalid dimensions, timeouts, or provider/binding combinations fail with one clear startup/request-construction error.
- Application services no longer parse raw env strings independently.
- Staging is represented truthfully in TypeScript.

### [x] CFG-3 — Reduce Wrangler duplication and remove historical narratives from manifests

Completed 2026-08-19. Manifests now contain local defaults plus the supported
production environment, concise invariant comments, and explicit rollback
bindings. Unsupported staging declarations and ambiguous deploy scripts were
removed; dry-run builds explicitly select the top-level environment.

**Finding**

The Wrangler files contain useful configuration but also incident history, old benchmark conclusions, rollback IDs, account anecdotes, and repeated environment blocks. This makes them long and makes current values difficult to review. Some production Vectorize bindings are described as dormant while still declared; staging removes them because Wrangler validates inactive bindings.

**Actions**

- Keep comments that explain Cloudflare inheritance rules or a binding invariant.
- Move incident narratives, historical provider failures, and benchmark numbers to ADRs/runbooks.
- Add a concise supported-provider matrix near the factory/config code.
- Decide explicitly whether dormant production bindings are required rollback infrastructure. If yes, label and test them; if no, remove only the bindings, not the adapters.
- Change build scripts to specify the intended empty/default environment explicitly so Wrangler's ambiguous-environment warning disappears.
- Remove or disable the root `deploy` command if it can accidentally target the default environment; prefer explicit staging/production deploy tasks.

**Acceptance criteria**

- A production-config diff shows current state, not several years of reasoning.
- Dry-run builds emit no environment-selection warning.
- No deployment command has an ambiguous target.

### [x] DB-1 — Repair migration workflow contradictions

Completed 2026-08-19. Drizzle snapshots are no longer ignored, the executable
chain has an automated journal/SQL/snapshot test, and automatic migration is a
guarded local-only command. Production uses one documented reviewed-SQL path.

**Finding**

`packages/db/migrations/README.md` says generated snapshots must be committed, but `.gitignore:15` ignores `packages/db/migrations/meta/`. Existing snapshots remain tracked only because they predate the ignore; a newly generated snapshot can be silently omitted.

The compact operations docs recommend `db:migrate`, while the migration README says never to use Drizzle migrate against production and to apply reviewed SQL manually. Migrations `0001` and `0002` are zero-byte journal entries with no explanation.

**Actions**

- Stop ignoring migration metadata that the workflow requires, or add an explicit unignore rule.
- Make one migration runbook authoritative for local, staging, and production.
- Add a CI check that schema changes include the expected SQL and snapshot changes.
- Document zero-byte applied migrations as intentional no-ops; do not delete or renumber applied migration history.
- Add a migration-name/constraint-name review during future schema changes; for example `uq_daily_usage_org_space_date` also contains `user_id`.

**Acceptance criteria**

- `db:generate` followed by `git status` always exposes every required artifact.
- No documentation suggests an unsafe production migration command without the manual-review warning.

### [x] ARCH-1 — Break the `@crosmos/db` barrel cycle

Completed 2026-08-19. Database construction and the `Database` type now live in
the `client` leaf module; usage rollups import that leaf while the package barrel
remains a public-only facade.

**Finding**

`packages/db/src/index.ts` re-exports `usage-rollup.ts`, while `usage-rollup.ts` imports `Database` from `index.ts`. It is currently type-only at runtime, but it is still a structural cycle and makes the package barrel both the public facade and an internal dependency.

**Actions**

- Move the database client type/factory to a leaf module such as `client.ts`.
- Have both the barrel and usage-rollup import from that leaf.
- Add an import-cycle check to CI.

**Acceptance criteria**

- The production source graph has zero cycles.

### [ ] ARCH-2 — Centralize duplicated cross-worker provider wiring

**Finding**

The API and ingestion implementations of `getEmbedder()` and `getVectorStore()` are near copies. Their comments have already diverged, and `buildQdrantStore()` exists only on the API side.

**Actions**

- Move provider-neutral construction inputs/types into the relevant shared package.
- Keep Worker binding extraction in each app, but call one shared builder for identical provider rules.
- Add adapter contract tests that run the same expectations against OpenAI/OpenRouter/Workers AI embedders and Qdrant/Vectorize/pgvector stores where feasible.

**Acceptance criteria**

- Embedding dimension/provider validation has one implementation.
- Qdrant default collection naming has one implementation.
- API and ingestion cannot silently choose different fallback semantics.

### [ ] ARCH-3 — Make route modules consistently HTTP-only at their outer layer

**Finding**

The feature pattern is only loosely followed. Some domains have substantial services; others perform direct Drizzle queries in route handlers. Across API route files there are 39 direct query-builder calls. `orgs/routes.ts` is 971 lines, `sources/routes.ts` 755, `search/routes.ts` 752, and `visibility/routes.ts` 533.

This creates four recurring responsibilities in one function: auth/HTTP mapping, transaction orchestration, persistence, and telemetry/compensation.

**Actions**

- Keep routes responsible for schema validation, auth middleware, translating application results to the wire contract, and HTTP-specific headers/statuses.
- Extract application use cases for multi-step operations such as source submission, conversation submission, search admission/execution, invitations, membership changes, and visibility grants.
- Keep focused query functions/repositories near their feature; do not add a generic repository abstraction over Drizzle.
- Pass explicit dependencies to complex use cases so failure paths can be tested without constructing a full Hono context.

**Acceptance criteria**

- Route handlers read as short orchestration adapters.
- Transaction boundaries and compensation live in named application functions.
- OpenAPI response behavior remains byte/shape compatible.

### [x] ARCH-4 — Decompose the largest orchestration functions without changing behavior

Completed 2026-08-19 through extraction-only stage seams: retrieval feature,
fusion, rerank, score/select, and response hydration; ingestion Stage 8 graph
linking; and job terminal rollup. Call order, telemetry names, error/fallback
paths, ranking constants, and data shapes are unchanged. Exact-score pipeline
fixtures and continuation/recovery suites remain unchanged and green.

**Finding**

The largest production functions are difficult to review as units:

- `ingestSource()` — 578 lines (`ingestion/pipeline.ts:409`);
- `processIngestionRun()` — 570 lines (`process-ingestion.ts:214`);
- main search route handler — about 553 lines (`search/routes.ts:199`);
- `retrieve()` — 524 lines (`search/service.ts:196`);
- `redriveStuckSources()` — 268 lines;
- graph traversal/load functions — 200-250 lines.

The code already has meaningful stages; the stage boundaries should become functions/modules rather than being explained by long comments inside one function.

**Actions**

- Extract one stage at a time, preserving call order, telemetry names, errors, and data structures.
- Use a typed context/result object where parameter lists would otherwise explode.
- Keep pure ranking/chunk-planning functions separate from I/O orchestration.
- Do not combine decomposition with provider migration, ranking tuning, query rewrites, or schema changes.

**Acceptance criteria**

- Existing deterministic/differential tests remain unchanged and green.
- Each extracted stage has one reason to change and a focused test seam.
- No new framework or generic pipeline engine is introduced.

### [x] ARCH-5 — Give the admin and ingestion workers a structure consistent with their size

Completed 2026-08-19. Admin now has a minimal entrypoint plus app/HTTP/schema
and audited application-operation modules; its transaction and audit ordering is
covered by the existing PostgreSQL operation suite. Ingestion is grouped into
delivery, job lifecycle, source pipeline, providers, and entrypoint areas.

**Finding**

`apps/admin/src/index.ts` contains nearly the entire admin API in 479 lines, unlike the feature-oriented public API. Ingestion is partly organized under `ingestion/` but leaves job-store, queue-consumer, source-status, usage, and process orchestration at the root.

**Actions**

- Split admin into route/schema/application-operation modules while preserving the separate security boundary.
- Group ingestion by lifecycle: entrypoint, delivery coordination, job lifecycle, source pipeline, providers.
- Keep entrypoints limited to binding construction, middleware, route/consumer registration, and scheduled/RPC dispatch.

**Acceptance criteria**

- Entry files present the application topology at a glance.
- Operational mutations remain audited and transactionally identical.

### [ ] TENANT-1 — Make the tenancy rule mechanically enforceable

**Finding**

The docs say every org/space query must use scope helpers, but direct predicates and ad hoc `{ orgId, spaceId }` objects are common. `TenantScope` is imported sometimes from `@crosmos/types` and sometimes through `apps/api/src/lib/scope.ts`.

This does not prove a current tenant leak; it proves the convention is not enforceable by review alone.

**Actions**

- Choose one import path for `TenantScope` within each app.
- Require scoped application/query functions for tenant-owned data.
- Add a focused lint rule or architectural test that flags direct access to sensitive tables outside approved scope/repository modules.
- Document intentional system/admin bypasses explicitly.

**Acceptance criteria**

- A new unscoped query against memories/sources/entities/edges/jobs fails CI or requires an explicit reviewed bypass.

### [x] API-1 — Standardize error schemas and exception ownership

Completed 2026-08-19. Normal API routes now reference one OpenAPI error schema
and emit the `detail`/`code`/`request_id`/`fields` envelope through shared
builders and the global mapper. Expected visibility/domain failures use
`AppError`; OAuth protocol routes retain their protocol-specific responses.

**Finding**

The code mixes `HTTPException`, domain `AppError` subclasses, raw `c.json()` errors, and protocol-specific OAuth errors. Error schemas are duplicated as `ErrorBody`, `BillingErrorSchema`, `ErrorResponseSchema`, `detail: string`, and `detail: unknown` across route modules.

Some variation is required: OAuth protocol endpoints should retain OAuth-standard error bodies. The rest is accidental inconsistency.

**Actions**

- Define one application error taxonomy and one shared OpenAPI schema set for normal API routes.
- Reserve `HTTPException` for HTTP-layer concerns and map domain errors centrally.
- Keep OAuth-standard errors as a documented exception.
- Remove stale route imports left by the `createApiApp()` migration.

**Acceptance criteria**

- Every non-OAuth API error uses the canonical envelope and a documented code/status mapping.
- OpenAPI describes the actual runtime envelope without per-feature copies.

## Priority 2: comment, dead-code, and repository sanitation

### [x] COMMENT-1 — Adopt a short, enforceable comment policy

Completed 2026-08-19. `docs/code-comment-policy.md` defines the permitted
invariants, review rule, length expectation, and material that belongs in ADRs,
runbooks, or dated evidence instead of production source.

Use comments for:

- security/tenancy invariants;
- queue state-machine and transaction/compensation constraints;
- non-obvious algorithmic formulas and score contracts;
- provider/runtime limitations that the type system cannot express;
- public ports where callers need a contract.

Move to ADRs/runbooks:

- incident timelines and percentages;
- old benchmark locations/results;
- provider-credit failures;
- migration/rollback resource IDs;
- why an old implementation was replaced;
- Python file-by-file parity history.

Delete:

- comments that restate the next line;
- comments referring to nonexistent `decisions.md`, `worker.md`, or `tenancy.md`;
- anonymous `issue #N`, `P0-A`, `P1-G`, and checklist references with no stable link;
- stale provider/default/deployment descriptions;
- comments justifying a function that can instead be named/extracted clearly.

A useful local shape is one sentence stating the invariant, followed by a stable ADR/test link only when needed. Four or more lines should be exceptional for private implementation functions.

**Acceptance criteria**

- Private functions do not carry historical essays.
- Long comments that remain explain a current invariant and are backed by a test, ADR, or external platform constraint.

### [x] COMMENT-2 — Perform a targeted stale-comment sweep

Completed 2026-08-19. The confirmed embedding dimension, placement, provider
default, OpenRouter parity, missing-document, timeout-incident, and Wrangler
narratives were corrected or removed without changing executable settings.

Start with these confirmed contradictions:

- `apps/api/src/integrations/embeddings/index.ts:13-35` and the ingestion twin say OpenAI is pinned to 1024 dimensions; production is 1536.
- The API embedding factory calls the Worker “Singapore-placed”; production is targeted to US East.
- `packages/ai/src/embeddings/index.ts:19-38` calls 1024 the canonical dimension “for this deployment”; it is only the code fallback/default for the dormant Workers AI/Vectorize path.
- `packages/ai/src/embeddings/port.ts:1-13` calls Workers AI the default provider and OpenAI the fallback without distinguishing code defaults from production selection.
- `apps/ingestion/src/integrations/llm/openrouter.ts:4-6` ties the adapter model to dead `MODEL_NAME` parity language even though production extraction uses the OpenAI adapter.
- multiple files link to missing `decisions.md`, `worker.md`, and `tenancy.md`.
- `apps/api/src/features/search/constants.ts:120-151` embeds a full 2026-07-25 incident narrative around a simple timeout invariant.
- Wrangler manifests contain dated placement/provider incident narratives better suited to ADRs.

Do not mass-delete comments by line count. Review each comment against the policy above.

### [x] DEAD-1 — Remove confirmed non-adapter dead code and stale imports

Completed 2026-08-19. The unwired intent classifier, duplicate unused entity
ontology, zero-consumer constants/helpers, stale route imports, and accidental
empty root file were removed. Production compiles with unused locals and
parameters enabled; all provider adapters remain available.

The following are confirmed by repository-wide reference search or compiler diagnostics and should be removed after one final dynamic-entrypoint check:

- `apps/api/src/features/search/intent.ts` and the associated `QueryIntent`/`IntentAnalysis` types: explicitly not wired into retrieval.
- `apps/ingestion/src/ontology/entity-types.ts`: unused, while the graph prompt hardcodes a separate entity list. Prefer making one source authoritative rather than merely deleting the module.
- unused constants: `MODEL_NAME`, `ENTITY_NAME_MAX_LENGTH`, `MONITOR_INTERVAL_SECONDS`, `SESSION_LOOKBACK_WINDOW`, API `SEGMENT_SIZE`, API `LOOKBACK_WINDOW`, `RETRIEVAL_CONNECTION_LIMIT`, `RETRIEVAL_MAX_QUEUE_DEPTH`, and `CANONICAL_RELATIONS`.
- unused private `getOrCreateEntity()`.
- unused exports/helpers such as `checkCountQuota()` and `scopeIngestionJobs()` if the final export check confirms no script consumer.
- unused route/service/schema imports reported by `noUnusedLocals`.
- ingestion `ZEROENTROPY_API_KEY` binding/type and its operations-doc entry; ingestion does not rerank.
- the tracked empty root file `undefined`.

**Acceptance criteria**

- The unused-code gate passes with no unexplained exceptions.
- Removal changes no Worker bundle entrypoint or wire contract.

### [ ] DEAD-2 — Classify dormant adapters instead of deleting them

OpenRouter must remain. The same reasoning applies to provider adapters that are credible rollback or near-term migration options.

Create a small support matrix with these states:

- `production` — OpenAI embeddings, Qdrant, ZeroEntropy; OpenAI extraction;
- `migration candidate` — Voyage reranker;
- `supported fallback` — OpenRouter extraction/embeddings, if still operationally supported;
- `development/rollback` — Workers AI, Vectorize, pgvector;
- `deprecated` — only after a deliberate decision and removal window.

Each retained adapter should have a construction test and a shared contract test. “Kept for later” without a test or config path becomes silent bit rot.

### [ ] REPO-1 — Clean generated and accidental artifacts

**Finding**

- `undefined` is a tracked empty file.
- `scripts/prod-latency-result.json` is a mutable generated-looking result at a fixed path.
- the 2.8 MB pipeline fixture is intentional but needs a clear regeneration/version policy.
- pre-baseline migrations are intentionally archived, but current docs must distinguish them from executable migrations.

**Actions**

- Delete `undefined`.
- Move benchmark outputs under ignored `bench-results/`, or commit immutable dated evidence under `docs/` with provenance.
- Keep the deterministic pipeline fixture if its value justifies its size; document the exact regeneration command and provider/model versions.
- Keep archived migrations for audit; do not treat them as executable or dead-code candidates.

### [ ] STYLE-1 — Add formatting with deliberate exclusions

**Finding**

There is no formatter configuration, and style varies across newer compact files and older expanded modules. Prompt strings and inline HTML naturally produce long lines and should not drive general code style.

**Actions**

- Adopt one formatter and format only mechanical changes in a dedicated PR.
- Exclude generated fixtures/migrations and configure prompt/template handling intentionally.
- Avoid mixing a repository-wide format pass with semantic refactors.

### [ ] TEST-2 — Reduce test-log noise and make database isolation explicit

**Finding**

API tests emit large volumes of production-shaped structured logs. This makes failures difficult to find. Database-backed test packages rely on default database names and cleanup conventions that are easy to collide when commands are run outside the package scripts.

**Actions**

- Inject a recording/no-op logger for tests by default, with explicit tests for logging behavior.
- Give each workspace a distinct documented test database in its canonical test command.
- Make destructive test setup validate that the target is a test database before truncation/drop.
- Document which tests require Postgres and which are pure.

**Acceptance criteria**

- A normal successful test run is concise.
- Parallel workspace tests cannot operate on the same database accidentally.

### [x] OBS-1 — Split the observability package by responsibility

Completed 2026-08-19. Logging/PII filtering, metrics, stage recording, tracing
contracts, error serialization, timing, and public types now have separate leaf
modules behind the unchanged package root. All Workers use the same structural
analytics/version types, with focused privacy and serialization tests.

**Finding**

`packages/observability/src/index.ts` is 504 lines and contains log types, PII allowlisting, normalization, console transport, metrics, stage recording, and tracing contracts. It is a well-designed package whose single-file shape now hides its internal boundaries.

**Actions**

- Split into `logging`, `metrics`, `stages`, and `tracing` leaf modules behind the same public exports.
- Add tests for field allowlisting, nested normalization, dropped-field warnings, error serialization, and production behavior—not only metric positions.
- Standardize all workers on the exported structural `AnalyticsDataset`/version metadata types instead of mixing local and Cloudflare-global shapes.

## Suggested execution order

Keep each pull request behavior-neutral and independently reversible.

### PR 0 — Credential incident/hygiene

- Rotate credentials.
- Remove `.bench.env` from current tree/history.
- Add example file, ignore rule, secret scanning.

### PR 1 — Quality gates only

- Add CI/root `check`.
- Add formatter/linter/unused/dependency-cycle/test-typecheck gates.
- Fix existing gate failures mechanically.
- Make dry-run environment selection explicit.

### PR 2 — Dead-code and artifact sanitation

- Remove confirmed unused imports/functions/constants/files.
- Resolve the entity-ontology duplicate source of truth.
- Classify and test dormant adapters; retain OpenRouter and Voyage.

### PR 3 — Documentation/comment reset

- Rewrite `.codex` current-state docs and provider matrix.
- Mark dated docs historical/superseded.
- Move incident history from source/Wrangler comments into ADRs.
- Apply the comment policy module by module.

### PR 4 — Shared config and package boundaries

- Add validated worker config readers and shared deployment types.
- Add cross-Wrangler consistency tests.
- Centralize duplicate embedder/vector-store builders.
- Break the DB cycle and add boundary checks.

### PR 5+ — Characterization-backed decomposition

Suggested order:

1. admin entrypoint;
2. org/visibility routes;
3. source/conversation submission use case;
4. search route orchestration;
5. `retrieve()` stages;
6. ingestion job orchestration;
7. `ingestSource()` stages;
8. observability package split.

Do one seam at a time. Do not combine these with Voyage promotion, ranking changes, schema feature work, or provider changes.

## Non-breaking verification gate for every cleanup PR

- `bun run check` passes once introduced.
- Existing unit and Postgres integration tests pass.
- Deterministic ingestion/retrieval fixture baseline is unchanged unless the PR is explicitly updating the fixture with a reviewed reason.
- Generated OpenAPI is semantically unchanged for refactor-only PRs.
- API, ingestion, and admin dry-run bundles pass for the intended environment.
- Worker bindings, queue names, service bindings, Durable Object migrations, cron schedules, and routes are unchanged unless named in the PR.
- Migration SQL and snapshot state are unchanged for code-only sanitation.
- No provider adapter is removed solely because it is not the production default.
- No ranking constant, timeout, retry policy, quota, or response schema is changed in a mechanical cleanup.

## Definition of done for this sanitation effort

- The tracked credential incident is closed.
- A new engineer can learn the current architecture from one compact LLD that agrees with Wrangler and code.
- Production comments mostly explain current invariants, not history.
- There are no unexplained unused files/exports/imports or accidental artifacts.
- Test code is typechecked in the default quality command.
- CI enforces formatting, lint, dead-code, cycle, boundary, migration, test, and build checks.
- The largest route and pipeline orchestrators have named, testable stages while preserving behavior.
- Production provider truth is explicit: OpenAI `text-embedding-3-small` at 1536 dimensions, Qdrant, ZeroEntropy `zerank-2` enabled; Voyage remains a tested migration candidate and OpenRouter remains a supported retained adapter.
