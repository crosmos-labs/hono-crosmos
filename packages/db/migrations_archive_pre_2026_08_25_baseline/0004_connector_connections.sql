CREATE TABLE "connector_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid NOT NULL,
	"org_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"owner_user_id" integer,
	"provider" varchar(50) NOT NULL,
	"auth_backend" varchar(50) NOT NULL,
	"auth_connection_id" varchar(255) NOT NULL,
	"external_account_id" varchar(255),
	"display_name" varchar(255),
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"connected_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_connections_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "ck_connector_connection_status" CHECK ("connector_connections"."status" IN ('pending', 'active', 'expired', 'failed', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_space_id_memory_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_connections_org_id_idx" ON "connector_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "connector_connections_space_id_idx" ON "connector_connections" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "connector_connections_owner_user_id_idx" ON "connector_connections" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "connector_connections_provider_status_idx" ON "connector_connections" USING btree ("provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connector_auth_connection" ON "connector_connections" USING btree ("auth_backend","auth_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connector_space_provider_live" ON "connector_connections" USING btree ("space_id","provider") WHERE "connector_connections"."status" IN ('pending', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connector_space_external_account" ON "connector_connections" USING btree ("space_id","provider","external_account_id") WHERE "connector_connections"."external_account_id" IS NOT NULL AND "connector_connections"."status" IN ('pending', 'active');