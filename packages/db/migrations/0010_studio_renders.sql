-- Studio renders: server-side ffmpeg assembly of a multi-clip timeline into one MP4.
-- Applied directly to the live DB on 2026-06-07 (W5 video-editor push); this file
-- mirrors that DDL for fresh environments.
CREATE TABLE IF NOT EXISTS "studio_renders" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "spec" jsonb NOT NULL,
  "result_url" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "studio_renders" ADD CONSTRAINT "studio_renders_user_id_users_app_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_renders_user_id_idx" ON "studio_renders" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_renders_status_idx" ON "studio_renders" ("status");
--> statement-breakpoint
-- Studio render outputs land in the gallery without a source AI job.
ALTER TABLE "gallery_items" ALTER COLUMN "job_id" DROP NOT NULL;
