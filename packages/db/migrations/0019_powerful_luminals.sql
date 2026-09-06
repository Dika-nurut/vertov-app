CREATE TABLE IF NOT EXISTS "script_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"script_id" text NOT NULL,
	"rev" integer NOT NULL,
	"fountain" text NOT NULL,
	"cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "script_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"script_id" text NOT NULL,
	"user_id" text NOT NULL,
	"anchor" jsonb,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scripts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT 'Новый сценарий' NOT NULL,
	"fountain" text DEFAULT '' NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"bible" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "merge_mode" text DEFAULT 'replace' NOT NULL;--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "slots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "negative_prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "badge" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "fallback_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "preview_kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "modality" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "script_snapshots" ADD CONSTRAINT "script_snapshots_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "script_threads" ADD CONSTRAINT "script_threads_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "script_threads" ADD CONSTRAINT "script_threads_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scripts" ADD CONSTRAINT "scripts_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "script_snapshots_script_id_idx" ON "script_snapshots" USING btree ("script_id","rev");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "script_threads_script_id_idx" ON "script_threads" USING btree ("script_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scripts_user_id_idx" ON "scripts" USING btree ("user_id");