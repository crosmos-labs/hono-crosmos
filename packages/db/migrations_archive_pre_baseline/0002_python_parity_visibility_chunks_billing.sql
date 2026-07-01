DO $$ BEGIN
 CREATE TYPE "public"."memory_visibility" AS ENUM('private', 'org');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "visibility_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "owner_user_id" integer REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "visibility" "memory_visibility" DEFAULT 'private' NOT NULL;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "owner_user_id" integer REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "visibility" "memory_visibility" DEFAULT 'private' NOT NULL;
--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN IF NOT EXISTS "owner_user_id" integer REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN IF NOT EXISTS "visibility" "memory_visibility" DEFAULT 'private' NOT NULL;
--> statement-breakpoint
UPDATE "sources" s
SET "owner_user_id" = ms."user_id"
FROM "memory_spaces" ms
WHERE s."space_id" = ms."id" AND s."owner_user_id" IS NULL;
--> statement-breakpoint
UPDATE "memories" m
SET "owner_user_id" = s."owner_user_id"
FROM "source_memories" sm
JOIN "sources" s ON s."id" = sm."source_id"
WHERE m."id" = sm."memory_id" AND m."owner_user_id" IS NULL;
--> statement-breakpoint
UPDATE "edges" e
SET "owner_user_id" = m."owner_user_id"
FROM "memories" m
WHERE e."memory_id" = m."id" AND e."owner_user_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sources_org_owner" ON "sources" USING btree ("org_id","owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_org_owner" ON "memories" USING btree ("org_id","owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_edges_org_owner" ON "edges" USING btree ("org_id","owner_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"source_id" integer NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"chunker" varchar(32) DEFAULT 'legacy' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_source_id_sequence_idx" ON "chunks" USING btree ("source_id","sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_space_id_idx" ON "chunks" USING btree ("space_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_org_id_idx" ON "chunks" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_created_at_idx" ON "chunks" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chunks_org_space" ON "chunks" USING btree ("org_id","space_id");
--> statement-breakpoint
INSERT INTO "chunks" ("uuid", "org_id", "space_id", "source_id", "sequence", "content", "token_count", "chunker", "created_at")
SELECT gen_random_uuid(), s."org_id", s."space_id", s."id", 0, s."content", coalesce(s."token_count", 0), 'legacy', s."created_at"
FROM "sources" s;
--> statement-breakpoint
ALTER TABLE "source_memories" DROP CONSTRAINT IF EXISTS "source_memories_source_id_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "source_memories" DROP CONSTRAINT IF EXISTS "source_memories_source_id_fkey";
--> statement-breakpoint
ALTER TABLE "source_memories" RENAME COLUMN "source_id" TO "chunk_id";
--> statement-breakpoint
UPDATE "source_memories" sm
SET "chunk_id" = c."id"
FROM "chunks" c
WHERE c."source_id" = sm."chunk_id" AND c."sequence" = 0;
--> statement-breakpoint
ALTER TABLE "source_memories" ADD CONSTRAINT "chunk_memories_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER INDEX IF EXISTS "source_memories_source_id_idx" RENAME TO "chunk_memories_chunk_id_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "source_memories_memory_id_idx" RENAME TO "chunk_memories_memory_id_idx";
--> statement-breakpoint
ALTER TABLE "source_memories" RENAME CONSTRAINT "uq_source_memories" TO "uq_chunk_memory";
--> statement-breakpoint
ALTER TABLE "source_memories" RENAME TO "chunk_memories";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "sequence";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visibility_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visibility_groups_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "uq_visibility_groups_org_slug" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visibility_group_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visibility_group_members_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "uq_visibility_group_members" UNIQUE("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visibility_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"viewer_group_id" integer NOT NULL,
	"subject_group_id" integer NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visibility_grants_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "uq_visibility_grants_edge" UNIQUE("org_id","viewer_group_id","subject_group_id"),
	CONSTRAINT "ck_visibility_grants_no_self" CHECK ("viewer_group_id" <> "subject_group_id")
);
--> statement-breakpoint
ALTER TABLE "visibility_groups" ADD CONSTRAINT "visibility_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visibility_groups" ADD CONSTRAINT "visibility_groups_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visibility_group_members" ADD CONSTRAINT "visibility_group_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visibility_group_members" ADD CONSTRAINT "visibility_group_members_group_id_visibility_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."visibility_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visibility_group_members" ADD CONSTRAINT "visibility_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_viewer_group_id_visibility_groups_id_fk" FOREIGN KEY ("viewer_group_id") REFERENCES "public"."visibility_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_subject_group_id_visibility_groups_id_fk" FOREIGN KEY ("subject_group_id") REFERENCES "public"."visibility_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visibility_groups_org_id_idx" ON "visibility_groups" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visibility_group_members_org_user_idx" ON "visibility_group_members" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visibility_group_members_group_id_idx" ON "visibility_group_members" USING btree ("group_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visibility_grants_org_id_idx" ON "visibility_grants" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visibility_grants_viewer_group_idx" ON "visibility_grants" USING btree ("viewer_group_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"polar_event_id" varchar(64) NOT NULL,
	"org_id" integer,
	"event_type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "billing_events_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_events_polar_event_id_idx" ON "billing_events" USING btree ("polar_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_events_org_id_idx" ON "billing_events" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_events_event_type_idx" ON "billing_events" USING btree ("event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_events_unprocessed_idx" ON "billing_events" USING btree ("processed_at");
