-- Studio projects: the user's autosaved editor composition (one row per user)
-- so closing the tab doesn't lose the timeline.
CREATE TABLE IF NOT EXISTS "studio_projects" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL UNIQUE,
  "timeline" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "studio_projects" ADD CONSTRAINT "studio_projects_user_id_users_app_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
