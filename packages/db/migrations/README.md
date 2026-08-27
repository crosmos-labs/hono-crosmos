# Migrations

`0000_baseline_2026_08_25.sql` is a **squashed baseline** generated from the
committed `src/schema/*.ts` on 2026-08-25. It represents the full schema **already
live in prod and staging** — do NOT run it against those databases (it CREATEs
every table). It exists so `drizzle-kit generate` has a truthful snapshot to diff
future changes against, and so a fresh/empty DB (local dev, a new env) can be
bootstrapped in one step.

Earlier SQL history is preserved in `../migrations_archive_pre_baseline/` and
`../migrations_archive_pre_2026_08_25_baseline/` for audit. The generated
`meta/` journal and snapshots are committed from this baseline onward; Drizzle
cannot safely generate schema diffs without them.

## Workflow (important)

- **Never** `drizzle-kit migrate` against prod. The prod DB is managed by applying
  generated migration SQL via `psql` (the deploy pipeline does not run
  migrations). See the staging/prod cutover docs.
- To make a schema change: edit `src/schema/*.ts`, run `drizzle-kit generate` to
  produce the next numbered migration + snapshot (commit both), then apply that
  SQL to prod/staging by hand via `psql` and verify.
