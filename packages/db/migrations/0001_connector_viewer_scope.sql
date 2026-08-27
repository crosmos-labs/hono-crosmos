DROP INDEX "uq_connector_space_provider_live";--> statement-breakpoint
DROP INDEX "uq_connector_space_external_account";--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "viewer_user_id" integer;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_viewer_user_id_users_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_connections_viewer_user_id_idx" ON "connector_connections" USING btree ("viewer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connector_viewer_space_external_account" ON "connector_connections" USING btree ("space_id","viewer_user_id","provider","external_account_id") WHERE "connector_connections"."external_account_id" IS NOT NULL AND "connector_connections"."status" IN ('pending', 'active');