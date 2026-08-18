# Database migrations

`0000_baseline.sql` is the squashed bootstrap schema for a new empty database.
It describes schema already present in production and must never be applied to
the existing production database. Pre-baseline history is retained under
`migrations_archive_pre_baseline/` for audit only and is not executable input.

The executable chain is this directory's numbered SQL, `meta/_journal.json`,
and one committed `meta/*_snapshot.json` per journal entry. The small `0001` and
`0002` files are intentional single-column migrations, not empty placeholders.

## Creating a migration

1. Edit `src/schema/*.ts`.
2. Set a direct `DATABASE_URL` and run `bun run db:generate` from the repository
   root.
3. Review the generated SQL for locking, transaction, compatibility, and
   rollback implications.
4. Commit the numbered SQL, journal, and generated snapshot together.
5. Run the migration-chain test and build a fresh local database from the chain.

Snapshots are deliberately tracked. Do not add `migrations/meta/` back to
`.gitignore`.

## Applying migrations

For a disposable local database only:

```sh
DATABASE_URL=postgresql://crosmos:crosmos@localhost:5433/crosmos \
  bun run db:migrate:local
```

The command refuses non-local hosts. Production changes are deliberate operator
operations: back up and preflight the target, select the reviewed numbered SQL,
apply that file explicitly with `psql`, then verify schema and application health.
Do not point `drizzle-kit migrate` or `db:migrate:local` at production. Some
reviewed migrations, including `0003`, intentionally require statement-level
execution rather than a tool-managed transaction.
