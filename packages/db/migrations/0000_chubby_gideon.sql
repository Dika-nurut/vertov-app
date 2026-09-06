CREATE TYPE "public"."credit_account" AS ENUM('available', 'pending', 'subscription_grant', 'pack_grant', 'refund', 'spend');--> statement-breakpoint
CREATE TYPE "public"."gallery_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."model_kind" AS ENUM('image', 'image-edit', 'video', 'voice');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('subscription', 'pack');--> statement-breakpoint
CREATE TYPE "public"."order_our_status" AS ENUM('pending', 'paid', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('byteplus', 'volcengine', 'yandex', 'stub');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('free', 'start', 'creator', 'studio');--> statement-breakpoint
CREATE TYPE "public"."unit_kind" AS ENUM('image', 'second', '1k_chars');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'banned', 'deleted');--> statement-breakpoint
CREATE TABLE "users_app" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tg_user_id" text,
	"display_name" text,
	"locale" text DEFAULT 'ru' NOT NULL,
	"tier" "tier" DEFAULT 'free' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "users_app_tg_user_id_unique" UNIQUE("tg_user_id")
);
--> statement-breakpoint
CREATE TABLE "users_pii" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"phone" text,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"last_payment_method_brand" text,
	CONSTRAINT "users_pii_email_unique" UNIQUE("email"),
	CONSTRAINT "users_pii_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tier" "tier" NOT NULL,
	"status" "subscription_status" NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"account" "credit_account" NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"related_job_id" text,
	"related_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"ua" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "provider" NOT NULL,
	"family" text NOT NULL,
	"variant" text NOT NULL,
	"kind" "model_kind" NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"tier_min" "tier" DEFAULT 'free' NOT NULL,
	"credit_cost_per_unit" integer NOT NULL,
	"unit_kind" "unit_kind" NOT NULL,
	"expected_latency_ms_p50" integer NOT NULL,
	"expected_latency_ms_p95" integer NOT NULL,
	"max_duration_seconds" integer,
	"max_resolution" text,
	"provider_model_id" text NOT NULL,
	"provider_endpoint" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rights_moderation_provider" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"model_id" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reference_assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"name" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"parent_workflow_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"model_id" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"provider_job_id" text,
	"result_assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"credits_reserved" integer DEFAULT 0 NOT NULL,
	"credits_spent" integer DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "gallery_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"job_id" text NOT NULL,
	"asset_url" text NOT NULL,
	"thumbnail_url" text,
	"kind" "gallery_kind" NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"title" text,
	"prompt_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "order_kind" NOT NULL,
	"tier_or_pack_id" text NOT NULL,
	"amount_rub" integer NOT NULL,
	"psp" text DEFAULT 'yookassa' NOT NULL,
	"psp_payment_id" text,
	"psp_status" text,
	"our_status" "order_our_status" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users_pii" ADD CONSTRAINT "users_pii_id_users_app_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_parent_workflow_id_workflows_id_fk" FOREIGN KEY ("parent_workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_user_id_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_tx_user_id_idx" ON "credit_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_tx_user_created_idx" ON "credit_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "models_active_tier_idx" ON "models" USING btree ("is_active","tier_min");--> statement-breakpoint
CREATE INDEX "models_kind_idx" ON "models" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "workflows_user_id_idx" ON "workflows" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workflows_model_id_idx" ON "workflows" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "workflows_parent_id_idx" ON "workflows" USING btree ("parent_workflow_id");--> statement-breakpoint
CREATE INDEX "jobs_user_id_idx" ON "jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_workflow_id_idx" ON "jobs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "jobs_model_id_idx" ON "jobs" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "gallery_user_id_idx" ON "gallery_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gallery_job_id_idx" ON "gallery_items" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "gallery_public_idx" ON "gallery_items" USING btree ("is_public","published_at");--> statement-breakpoint
CREATE INDEX "orders_user_id_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_psp_payment_idx" ON "orders" USING btree ("psp_payment_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");