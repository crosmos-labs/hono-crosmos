# Migrations

`0000_baseline.sql` is a **squashed baseline** regenerated from the current
`src/schema/*.ts` on 2026-07-02. It represents the full schema that is **already
live in prod and staging** — do NOT run it against those databases (it CREATEs
every table). It exists so `drizzle-kit generate` has a truthful snapshot to diff
future changes against, and so a fresh/empty DB (local dev, a new env) can be
bootstrapped in one step.

The pre-baseline history (`0000`–`0005`) is preserved in
`../migrations_archive_pre_baseline/` for audit. Its `meta/` snapshot chain was
incomplete (snapshots `0002`–`0004` were never committed), which broke
`drizzle-kit generate`; the squash fixes that.

## Workflow (important)

- **Never** `drizzle-kit migrate` against prod. The prod DB is managed by applying
  hand-written SQL via `psql` (the deploy pipeline does not run migrations). See
  the staging/prod cutover docs.
- To make a schema change: edit `src/schema/*.ts`, run `drizzle-kit generate` to
  produce the next numbered migration + snapshot (commit both), then apply that
  SQL to prod/staging by hand via `psql` and verify.
