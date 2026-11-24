CREATE TYPE "public"."post_status" AS ENUM('draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled', 'removed');--> statement-breakpoint
CREATE TYPE "public"."post_target_status" AS ENUM('pending', 'publishing', 'published', 'failed', 'cancelled', 'removed');--> statement-breakpoint
CREATE TYPE "public"."publish_job_status" AS ENUM('due', 'running', 'done', 'dead');--> statement-breakpoint
CREATE TYPE "public"."publish_outcome" AS ENUM('success', 'transient_error', 'permanent_error', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."social_account_status" AS ENUM('connected', 'reconnect_needed', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."social_network" AS ENUM('facebook_page');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"public_url" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"attached_at" timestamp with time zone,
	"created_by_client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"admin_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_token_key_version" smallint,
	"user_token_iv" text,
	"user_token_ciphertext" text,
	"user_token_tag" text,
	"pages" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "post_media" (
	"post_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "post_media_post_id_position_pk" PRIMARY KEY("post_id","position")
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"status" "post_target_status" DEFAULT 'pending' NOT NULL,
	"external_post_id" text,
	"permalink" text,
	"published_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"dedupe_marker" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"caption" text NOT NULL,
	"status" "post_status" NOT NULL,
	"scheduled_for" timestamp with time zone,
	"source" text NOT NULL,
	"source_ref" text,
	"created_by_client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"post_target_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "publish_outcome",
	"http_status" integer,
	"meta_error_code" integer,
	"meta_error_subcode" integer,
	"message" text,
	"external_post_id" text
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"post_target_id" uuid NOT NULL,
	"status" "publish_job_status" DEFAULT 'due' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"check_before_publish" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_jobs_post_target_id_unique" UNIQUE("post_target_id")
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"network" "social_network" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"picture_url" text,
	"token_key_version" smallint,
	"token_iv" text,
	"token_ciphertext" text,
	"token_tag" text,
	"status" "social_account_status" DEFAULT 'connected' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"connected_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_response_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "webhook_secret_key_version" smallint;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "webhook_secret_iv" text;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "webhook_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "webhook_secret_tag" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_client_id_api_clients_id_fk" FOREIGN KEY ("created_by_client_id") REFERENCES "public"."api_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_client_id_api_clients_id_fk" FOREIGN KEY ("created_by_client_id") REFERENCES "public"."api_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_tenant_sha_idx" ON "media_assets" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE INDEX "media_assets_unused_idx" ON "media_assets" USING btree ("attached_at","created_at");--> statement-breakpoint
CREATE INDEX "post_media_asset_idx" ON "post_media" USING btree ("media_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_post_account_idx" ON "post_targets" USING btree ("post_id","social_account_id");--> statement-breakpoint
CREATE INDEX "post_targets_account_idx" ON "post_targets" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "posts_tenant_created_idx" ON "posts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_tenant_source_ref_idx" ON "posts" USING btree ("tenant_id","source_ref");--> statement-breakpoint
CREATE INDEX "publish_attempts_target_idx" ON "publish_attempts" USING btree ("post_target_id");--> statement-breakpoint
CREATE INDEX "publish_attempts_started_idx" ON "publish_attempts" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "publish_jobs_status_run_at_idx" ON "publish_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_tenant_network_external_idx" ON "social_accounts" USING btree ("tenant_id","network","external_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");