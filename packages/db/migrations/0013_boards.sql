-- «Доска»: project workspaces — infinite canvas documents per user.
CREATE TABLE IF NOT EXISTS "boards" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "title" text DEFAULT 'Новый проект' NOT NULL,
  "state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "boards" ADD CONSTRAINT "boards_user_id_users_app_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boards_user_id_idx" ON "boards" ("user_id");
