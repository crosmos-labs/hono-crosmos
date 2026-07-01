CREATE TYPE "public"."ingestion_job_status" AS ENUM('pending', 'processing', 'completed', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('viewpoint', 'semantic', 'episode', 'inference');--> statement-breakpoint
CREATE TYPE "public"."memory_visibility" AS ENUM('private', 'org');--> statement-breakpoint
CREATE TYPE "public"."org_role_type" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."plan_type" AS ENUM('free', 'developer', 'pro', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."source_extraction_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."subscription_status_type" AS ENUM('none', 'active', 'past_due', 'canceled', 'revoked');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"space_id" integer,
	"key_prefix" varchar(12) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
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
CREATE TABLE "chunks" (
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
	"owner_user_id" integer,
	"visibility" "memory_visibility" DEFAULT 'private' NOT NULL,
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
	"embedding" vector(1024),
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"oauth_provider" varchar(50),
	"oauth_provider_id" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "uq_users_oauth_identity" UNIQUE("oauth_provider","oauth_provider_id")
);
--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" "org_role_type" DEFAULT 'member' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"invited_by" integer NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invites_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "organization_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "org_role_type" NOT NULL,
	"invited_by_user_id" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "uq_org_members_org_user" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"plan" "plan_type" DEFAULT 'free' NOT NULL,
	"is_personal" boolean DEFAULT false NOT NULL,
	"visibility_enabled" boolean DEFAULT false NOT NULL,
	"entitlements" jsonb,
	"posthog_flag_overrides" jsonb,
	"billing_email" varchar(255),
	"polar_customer_id" varchar(64),
	"polar_subscription_id" varchar(64),
	"subscription_status" "subscription_status_type" DEFAULT 'none' NOT NULL,
	"current_period_end" timestamp with time zone,
	"plan_pending" varchar(32),
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_polar_customer_id_unique" UNIQUE("polar_customer_id")
);
--> statement-breakpoint
CREATE TABLE "authorization_codes" (
	"code" varchar(255) PRIMARY KEY NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"user_id" integer NOT NULL,
	"redirect_uri" varchar(2048) NOT NULL,
	"code_challenge" varchar(255) NOT NULL,
	"code_challenge_method" varchar(10) DEFAULT 'S256' NOT NULL,
	"scope" varchar(1024),
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" varchar(255) PRIMARY KEY NOT NULL,
	"client_secret_hash" varchar(64),
	"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"client_name" varchar(255),
	"grant_types" text[] DEFAULT '{authorization_code,refresh_token}'::text[] NOT NULL,
	"response_types" text[] DEFAULT '{code}'::text[] NOT NULL,
	"token_endpoint_auth_method" varchar(50) DEFAULT 'client_secret_post' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revoked_refresh_tokens" (
	"jti" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_spaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"user_id" integer NOT NULL,
	"description" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_spaces_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "uq_memory_spaces_org_id_name" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"owner_user_id" integer,
	"visibility" "memory_visibility" DEFAULT 'private' NOT NULL,
	"content_type" varchar(20) DEFAULT 'text' NOT NULL,
	"content" text NOT NULL,
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
	"owner_user_id" integer,
	"visibility" "memory_visibility" DEFAULT 'private' NOT NULL,
	"content" text NOT NULL,
	"memory_type" "memory_type" NOT NULL,
	"embedding" vector(1024),
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
CREATE TABLE "chunk_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"chunk_id" integer NOT NULL,
	"memory_id" integer NOT NULL,
	"extraction_timestamp" timestamp with time zone,
	CONSTRAINT "uq_chunk_memory" UNIQUE("chunk_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "memory_entities" (
	"id" serial PRIMARY KEY NOT NULL,
	"memory_id" integer NOT NULL,
	"entity_id" integer NOT NULL,
	CONSTRAINT "uq_memory_entities" UNIQUE("memory_id","entity_id")
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
CREATE TABLE "visibility_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"viewer_group_id" integer NOT NULL,
	"subject_group_id" integer NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visibility_grants_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "uq_visibility_grants_edge" UNIQUE("org_id","viewer_group_id","subject_group_id"),
	CONSTRAINT "ck_visibility_grants_no_self" CHECK ("visibility_grants"."viewer_group_id" <> "visibility_grants"."subject_group_id")
);
--> statement-breakpoint
CREATE TABLE "visibility_group_members" (
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
CREATE TABLE "visibility_groups" (
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
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_codes" ADD CONSTRAINT "authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_codes" ADD CONSTRAINT "authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revoked_refresh_tokens" ADD CONSTRAINT "revoked_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_spaces" ADD CONSTRAINT "memory_spaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_spaces" ADD CONSTRAINT "memory_spaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_memories" ADD CONSTRAINT "chunk_memories_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_memories" ADD CONSTRAINT "chunk_memories_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_viewer_group_id_visibility_groups_id_fk" FOREIGN KEY ("viewer_group_id") REFERENCES "public"."visibility_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_subject_group_id_visibility_groups_id_fk" FOREIGN KEY ("subject_group_id") REFERENCES "public"."visibility_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_group_members" ADD CONSTRAINT "visibility_group_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_group_members" ADD CONSTRAINT "visibility_group_members_group_id_visibility_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."visibility_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_group_members" ADD CONSTRAINT "visibility_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_groups" ADD CONSTRAINT "visibility_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_groups" ADD CONSTRAINT "visibility_groups_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_org_id_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "api_keys_space_id_idx" ON "api_keys" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_created_at_idx" ON "api_keys" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_polar_event_id_idx" ON "billing_events" USING btree ("polar_event_id");--> statement-breakpoint
CREATE INDEX "billing_events_org_id_idx" ON "billing_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "billing_events_event_type_idx" ON "billing_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "billing_events_unprocessed_idx" ON "billing_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "chunks_source_id_sequence_idx" ON "chunks" USING btree ("source_id","sequence");--> statement-breakpoint
CREATE INDEX "chunks_space_id_idx" ON "chunks" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "chunks_org_id_idx" ON "chunks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "chunks_created_at_idx" ON "chunks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_chunks_org_space" ON "chunks" USING btree ("org_id","space_id");--> statement-breakpoint
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
CREATE INDEX "idx_edges_org_owner" ON "edges" USING btree ("org_id","owner_user_id");--> statement-breakpoint
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
CREATE INDEX "entities_name_simple_gin_idx" ON "entities" USING gin (to_tsvector('simple', "name"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "users_oauth_lookup_idx" ON "users" USING btree ("oauth_provider","oauth_provider_id");--> statement-breakpoint
CREATE INDEX "org_invites_org_id_idx" ON "organization_invites" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invites_token_hash_idx" ON "organization_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_invites_pending" ON "organization_invites" USING btree ("org_id","email") WHERE accepted_at IS NULL;--> statement-breakpoint
CREATE INDEX "org_members_user_id_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "org_members_org_role_idx" ON "organization_members" USING btree ("org_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_plan_idx" ON "organizations" USING btree ("plan");--> statement-breakpoint
CREATE INDEX "organizations_created_at_idx" ON "organizations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "authorization_codes_client_id_idx" ON "authorization_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "authorization_codes_expires_at_idx" ON "authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_clients_created_at_idx" ON "oauth_clients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "revoked_refresh_tokens_expires_at_idx" ON "revoked_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "memory_spaces_name_idx" ON "memory_spaces" USING btree ("name");--> statement-breakpoint
CREATE INDEX "memory_spaces_user_id_idx" ON "memory_spaces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_spaces_org_id_idx" ON "memory_spaces" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memory_spaces_created_at_idx" ON "memory_spaces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sources_space_id_idx" ON "sources" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "sources_org_id_idx" ON "sources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sources_content_type_idx" ON "sources" USING btree ("content_type");--> statement-breakpoint
CREATE INDEX "sources_extraction_status_idx" ON "sources" USING btree ("extraction_status");--> statement-breakpoint
CREATE INDEX "sources_created_at_idx" ON "sources" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_sources_org_space" ON "sources" USING btree ("org_id","space_id");--> statement-breakpoint
CREATE INDEX "idx_sources_org_owner" ON "sources" USING btree ("org_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "memories_memory_type_idx" ON "memories" USING btree ("memory_type");--> statement-breakpoint
CREATE INDEX "memories_created_at_idx" ON "memories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "memories_space_id_idx" ON "memories" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "memories_org_id_idx" ON "memories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memories_event_time_idx" ON "memories" USING btree ("event_time");--> statement-breakpoint
CREATE INDEX "memories_importance_idx" ON "memories" USING btree ("importance_score");--> statement-breakpoint
CREATE INDEX "idx_memories_org_space" ON "memories" USING btree ("org_id","space_id");--> statement-breakpoint
CREATE INDEX "idx_memories_org_owner" ON "memories" USING btree ("org_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "active_memories_space_idx" ON "memories" USING btree ("space_id") WHERE forgotten_at IS NULL;--> statement-breakpoint
CREATE INDEX "memories_content_search_gin_idx" ON "memories" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "memories_inferred_ids_gin_idx" ON "memories" USING gin ("inferred_ids");--> statement-breakpoint
CREATE INDEX "chunk_memories_chunk_id_idx" ON "chunk_memories" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "chunk_memories_memory_id_idx" ON "chunk_memories" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_entities_memory_id_idx" ON "memory_entities" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_entities_entity_id_idx" ON "memory_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_user_id_idx" ON "ingestion_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_space_id_idx" ON "ingestion_jobs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_org_id_idx" ON "ingestion_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_status_idx" ON "ingestion_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_created_at_idx" ON "ingestion_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "visibility_grants_org_id_idx" ON "visibility_grants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "visibility_grants_viewer_group_idx" ON "visibility_grants" USING btree ("viewer_group_id");--> statement-breakpoint
CREATE INDEX "visibility_group_members_org_user_idx" ON "visibility_group_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "visibility_group_members_group_id_idx" ON "visibility_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "visibility_groups_org_id_idx" ON "visibility_groups" USING btree ("org_id");