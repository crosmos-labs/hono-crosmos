-- pgvector powers vector(1536) columns + HNSW indexes on memories/entities.
-- pgcrypto provides gen_random_uuid() used as the default for ingestion_jobs.id (uuid4).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."ingestion_job_status" AS ENUM('pending', 'processing', 'completed', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('viewpoint', 'semantic', 'episode', 'inference');--> statement-breakpoint
CREATE TYPE "public"."source_extraction_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"date" date NOT NULL,
	"tokens_ingested" integer DEFAULT 0 NOT NULL,
	"search_queries" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_usage_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "uq_daily_usage_org_space_date" UNIQUE("org_id","user_id","space_id","date")
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"source_entity_id" integer NOT NULL,
	"target_entity_id" integer NOT NULL,
	"relation_type" varchar(100) NOT NULL,
	"memory_id" integer,
	"valid_from" timestamp with time zone,
	"confidence" double precision DEFAULT 1,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"forgotten_at" timestamp with time zone,
	CONSTRAINT "edges_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"name" text NOT NULL,
	"entity_type" text,
	"embedding" vector(1536),
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"content_type" varchar(20) DEFAULT 'text' NOT NULL,
	"content" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"extraction_status" "source_extraction_status" DEFAULT 'pending' NOT NULL,
	"meta" jsonb,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"content" text NOT NULL,
	"memory_type" "memory_type" NOT NULL,
	"embedding" vector(1536),
	"importance_score" double precision,
	"meta" jsonb,
	"event_time" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"access_frequency" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"forgotten_at" timestamp with time zone,
	"inferred_ids" integer[],
	"stability_score" integer,
	"inferred_at" timestamp with time zone,
	"clustered_at" timestamp with time zone,
	CONSTRAINT "memories_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "memory_entities" (
	"id" serial PRIMARY KEY NOT NULL,
	"memory_id" integer NOT NULL,
	"entity_id" integer NOT NULL,
	CONSTRAINT "uq_memory_entities" UNIQUE("memory_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "source_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"memory_id" integer NOT NULL,
	"extraction_timestamp" timestamp with time zone,
	CONSTRAINT "uq_source_memories" UNIQUE("source_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"status" "ingestion_job_status" DEFAULT 'pending' NOT NULL,
	"source_ids" jsonb NOT NULL,
	"result" jsonb,
	"error_message" text,
	"current_stage" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_memories" ADD CONSTRAINT "source_memories_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_memories" ADD CONSTRAINT "source_memories_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_usage_user_id_idx" ON "daily_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "daily_usage_org_id_idx" ON "daily_usage" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "daily_usage_user_date_idx" ON "daily_usage" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "edges_source_entity_id_idx" ON "edges" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX "edges_target_entity_id_idx" ON "edges" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX "edges_relation_type_idx" ON "edges" USING btree ("relation_type");--> statement-breakpoint
CREATE INDEX "edges_memory_id_idx" ON "edges" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "edges_valid_from_idx" ON "edges" USING btree ("valid_from");--> statement-breakpoint
CREATE INDEX "edges_space_id_idx" ON "edges" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "edges_org_id_idx" ON "edges" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_edges_org_space" ON "edges" USING btree ("org_id","space_id");--> statement-breakpoint
CREATE INDEX "edges_space_source_idx" ON "edges" USING btree ("space_id","source_entity_id");--> statement-breakpoint
CREATE INDEX "edges_space_target_idx" ON "edges" USING btree ("space_id","target_entity_id");--> statement-breakpoint
CREATE INDEX "edges_not_forgotten_idx" ON "edges" USING btree ("space_id") WHERE forgotten_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_entity_space_name" ON "entities" USING btree ("space_id",lower("name"));--> statement-breakpoint
CREATE INDEX "entities_name_idx" ON "entities" USING btree ("name");--> statement-breakpoint
CREATE INDEX "entities_type_idx" ON "entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "entities_space_id_idx" ON "entities" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "entities_org_id_idx" ON "entities" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_entities_org_space" ON "entities" USING btree ("org_id","space_id");--> statement-breakpoint
CREATE INDEX "entities_embedding_hnsw_idx" ON "entities" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "entities_name_gin_idx" ON "entities" USING gin (to_tsvector('english', "name"));--> statement-breakpoint
CREATE INDEX "sources_space_id_idx" ON "sources" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "sources_org_id_idx" ON "sources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sources_content_type_idx" ON "sources" USING btree ("content_type");--> statement-breakpoint
CREATE INDEX "sources_extraction_status_idx" ON "sources" USING btree ("extraction_status");--> statement-breakpoint
CREATE INDEX "sources_created_at_idx" ON "sources" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_sources_org_space" ON "sources" USING btree ("org_id","space_id");--> statement-breakpoint
CREATE INDEX "memories_memory_type_idx" ON "memories" USING btree ("memory_type");--> statement-breakpoint
CREATE INDEX "memories_created_at_idx" ON "memories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "memories_space_id_idx" ON "memories" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "memories_org_id_idx" ON "memories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memories_event_time_idx" ON "memories" USING btree ("event_time");--> statement-breakpoint
CREATE INDEX "memories_importance_idx" ON "memories" USING btree ("importance_score");--> statement-breakpoint
CREATE INDEX "idx_memories_org_space" ON "memories" USING btree ("org_id","space_id");--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "active_memories_space_idx" ON "memories" USING btree ("space_id") WHERE forgotten_at IS NULL;--> statement-breakpoint
CREATE INDEX "memories_content_search_gin_idx" ON "memories" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "memories_inferred_ids_gin_idx" ON "memories" USING gin ("inferred_ids");--> statement-breakpoint
CREATE INDEX "memory_entities_memory_id_idx" ON "memory_entities" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_entities_entity_id_idx" ON "memory_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "source_memories_source_id_idx" ON "source_memories" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_memories_memory_id_idx" ON "source_memories" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_user_id_idx" ON "ingestion_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_space_id_idx" ON "ingestion_jobs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_org_id_idx" ON "ingestion_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_status_idx" ON "ingestion_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_created_at_idx" ON "ingestion_jobs" USING btree ("created_at");