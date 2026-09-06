-- W3.Wed: library v2 — promote gallery_items to a first-class library
-- entity (folders, tags, public-slug, free-tier expiry).
-- Existing columns kept untouched so /gallery's existing remix flow
-- doesn't break.
ALTER TABLE "gallery_items"
	ADD COLUMN IF NOT EXISTS "folder" text;
--> statement-breakpoint
ALTER TABLE "gallery_items"
	ADD COLUMN IF NOT EXISTS "tags" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "gallery_items"
	ADD COLUMN IF NOT EXISTS "public_slug" text;
--> statement-breakpoint
ALTER TABLE "gallery_items"
	ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint

-- Unique on public_slug (NULL allowed multiple times). The slug is
-- minted lazily on first publish (W3.Thu) so most rows stay NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "gallery_items_public_slug_uidx"
	ON "gallery_items" ("public_slug")
	WHERE "public_slug" IS NOT NULL;
--> statement-breakpoint

-- Filter helpers for the W3.Wed library views.
CREATE INDEX IF NOT EXISTS "gallery_items_user_folder_idx"
	ON "gallery_items" ("user_id", "folder");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gallery_items_expires_at_idx"
	ON "gallery_items" ("expires_at")
	WHERE "expires_at" IS NOT NULL;
