-- Real-product presets: recipe fields on preset_packs (additive / forward-only).
-- Turns the full-string promptTemplate into a composable recipe: merge mode + slots +
-- negative + tags + model-fallback chain + video previews. All columns are defaulted
-- so every existing row keeps its current behavior (mergeMode 'replace').

ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "merge_mode" text DEFAULT 'replace' NOT NULL;
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "slots" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "negative_prompt" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "badge" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "fallback_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "preview_kind" text DEFAULT 'image' NOT NULL;
--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN IF NOT EXISTS "modality" text DEFAULT 'image' NOT NULL;
--> statement-breakpoint

-- Data step: preserve today's behavior for the 18 Seedance motion packs. They append
-- their camera/effect phrase after the user's prompt → mergeMode 'suffix', video modality.
-- (The seed file is the source of truth going forward; this keeps a pre-reseed DB correct.)
UPDATE "preset_packs"
   SET "merge_mode" = 'suffix', "modality" = 'video', "preview_kind" = 'video'
 WHERE "category" IN ('camera', 'effect', 'style') AND "input_kind" = 'image';
