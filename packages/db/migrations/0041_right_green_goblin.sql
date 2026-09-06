ALTER TYPE "public"."credit_account" ADD VALUE 'bonus_grant' BEFORE 'refund';--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "free_clusters" (
	"cluster_key" text PRIMARY KEY NOT NULL,
	"tokens_granted" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "free_grant_events" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster_key" text NOT NULL,
	"user_id" text NOT NULL,
	"level" text NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "free_phone_anchors" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"cluster_key" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "free_registration_windows" (
	"scope" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"registrations" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "free_grant_events" ADD CONSTRAINT "free_grant_events_cluster_key_free_clusters_cluster_key_fk" FOREIGN KEY ("cluster_key") REFERENCES "public"."free_clusters"("cluster_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_grant_events" ADD CONSTRAINT "free_grant_events_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_phone_anchors" ADD CONSTRAINT "free_phone_anchors_cluster_key_free_clusters_cluster_key_fk" FOREIGN KEY ("cluster_key") REFERENCES "public"."free_clusters"("cluster_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_phone_anchors" ADD CONSTRAINT "free_phone_anchors_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "free_grant_events_user_level_uq" ON "free_grant_events" USING btree ("user_id","level");--> statement-breakpoint
CREATE INDEX "free_grant_events_cluster_created_idx" ON "free_grant_events" USING btree ("cluster_key","created_at");--> statement-breakpoint
CREATE INDEX "free_grant_events_created_level_idx" ON "free_grant_events" USING btree ("created_at","level");