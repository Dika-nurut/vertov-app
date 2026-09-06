-- Phase 3: preset catalog facets, character library, showcase curation.

-- preset_packs: catalog category (camera|effect|style|scene) + input slot.
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'scene' NOT NULL;
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "input_kind" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint

-- characters: named reference-image sets («Персонажи»).
CREATE TABLE IF NOT EXISTS "characters" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "image_urls" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "characters" ADD CONSTRAINT "characters_user_id_users_app_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "characters_user_id_idx" ON "characters" ("user_id");
--> statement-breakpoint

-- gallery_items: human-curation marker for the public showcase feed.
ALTER TABLE "gallery_items" ADD COLUMN IF NOT EXISTS "featured_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gallery_items_featured_idx" ON "gallery_items" ("featured_at");
