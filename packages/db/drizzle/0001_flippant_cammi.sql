ALTER TABLE "api_keys" ADD COLUMN "last_four" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "auth_user_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_auth_user_id_idx" ON "tenants" USING btree ("auth_user_id");