-- Space-scoped API keys.
-- Adds an OPTIONAL space scope to api_keys. NULL (the default for all existing
-- rows) preserves the legacy org-wide behavior. When set, the auth layer pins
-- the request to this space and the data-plane gates reject any other space.
--
-- Applied to prod out-of-band via psql (the drizzle journal is behind prod for
-- billing_events/daily_usage; do NOT `drizzle-kit migrate` this repo against
-- prod). This file is the human record of that change.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "space_id" integer;

DO $$ BEGIN
  ALTER TABLE "api_keys"
    ADD CONSTRAINT "api_keys_space_id_memory_spaces_id_fk"
    FOREIGN KEY ("space_id") REFERENCES "memory_spaces"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "api_keys_space_id_idx" ON "api_keys" ("space_id");
