CREATE TABLE IF NOT EXISTS "script_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"script_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"chars" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "script_threads" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'thread' NOT NULL;--> statement-breakpoint
ALTER TABLE "script_threads" ADD COLUMN IF NOT EXISTS "conspect" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "script_threads" ADD COLUMN IF NOT EXISTS "conspect_upto" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "script_materials" ADD CONSTRAINT "script_materials_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "script_materials" ADD CONSTRAINT "script_materials_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "script_materials_script_id_idx" ON "script_materials" USING btree ("script_id");
