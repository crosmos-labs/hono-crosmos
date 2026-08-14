CREATE TABLE "admin_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"actor_email" varchar(255) NOT NULL,
	"action" varchar(100) NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_id" varchar(255) NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_log_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "daily_source_content_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"date" date NOT NULL,
	"content_type" varchar(50) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_source_content_types_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "uq_daily_source_content_type" UNIQUE("org_id","user_id","space_id","date","content_type")
);
--> statement-breakpoint
ALTER TABLE "daily_usage" ADD COLUMN "sources_ingested" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD COLUMN "sources_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD COLUMN "memories_created" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "granted_plan" "plan_type";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "granted_plan_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "daily_source_content_types" ADD CONSTRAINT "daily_source_content_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_source_content_types" ADD CONSTRAINT "daily_source_content_types_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_log_actor_idx" ON "admin_audit_log" USING btree ("actor_email");--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "daily_source_content_types_org_date_idx" ON "daily_source_content_types" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "daily_source_content_types_space_date_idx" ON "daily_source_content_types" USING btree ("space_id","date");--> statement-breakpoint
CREATE INDEX "daily_usage_org_date_idx" ON "daily_usage" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "organizations_granted_plan_expiry_idx" ON "organizations" USING btree ("granted_plan_expires_at") WHERE granted_plan IS NOT NULL;