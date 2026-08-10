-- P1-A — deferred space deletion + retained usage history.
--
-- Statement order here is DELIBERATE and differs from what `drizzle-kit
-- generate` emitted. Drizzle dropped `uq_memory_spaces_org_id_name` BEFORE
-- creating the partial unique index that replaces it, which leaves a window
-- with no name uniqueness at all — two concurrent space creations could both
-- succeed and permanently break the invariant on a live database.
--
-- Correct order: add the column, build both indexes CONCURRENTLY (no
-- write-blocking lock), and only then drop the old constraint once its
-- replacement is already enforcing.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Apply this
-- file with `psql -f` (autocommit per statement) — do NOT wrap it in BEGIN.
-- If a CONCURRENTLY build fails it leaves an INVALID index behind; drop it and
-- retry rather than assuming the index is usable.

--> statement-breakpoint
-- 1. Tombstone column. Nullable with no default, so this is a catalog-only
--    change: no table rewrite, only a brief ACCESS EXCLUSIVE lock.
ALTER TABLE "memory_spaces" ADD COLUMN "deleted_at" timestamp with time zone;

--> statement-breakpoint
-- 2. Pending-deletion lookup for the finalizer sweep. Partial, so it indexes
--    only tombstones rather than every space.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "memory_spaces_deleted_at_idx"
  ON "memory_spaces" USING btree ("deleted_at")
  WHERE deleted_at IS NOT NULL;

--> statement-breakpoint
-- 3. Replacement uniqueness, enforcing ACTIVE spaces only. Created BEFORE the
--    old constraint is dropped so uniqueness is never unenforced. A plain
--    unique constraint would keep a deleted space's name reserved until the
--    finalizer ran, so a user could not immediately recreate a space they had
--    just deleted.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_memory_spaces_active_org_id_name"
  ON "memory_spaces" USING btree ("org_id", "name")
  WHERE deleted_at IS NULL;

--> statement-breakpoint
-- 4. Now safe: the replacement above is already enforcing.
ALTER TABLE "memory_spaces" DROP CONSTRAINT "uq_memory_spaces_org_id_name";

--> statement-breakpoint
-- 5. Retain billing history past its space. The FK's ON DELETE CASCADE erased
--    usage rows when a space was deleted, so an org's recorded usage could go
--    DOWN, and it raced best-effort usage writes settling just after a delete.
--    `space_id` stays NOT NULL and keeps its uniqueness key; the org and user
--    foreign keys are unchanged.
--
--    NOT directly reversible: once usage rows outlive their spaces, restoring
--    this FK requires deciding what to do with the orphans. Treat re-adding it
--    as a data-policy change, not a rollback.
ALTER TABLE "daily_usage" DROP CONSTRAINT "daily_usage_space_id_memory_spaces_id_fk";
