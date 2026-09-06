ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
UPDATE "models" SET "display_name" = 'Nano Banana Pro' WHERE "id" = 'gemini-3-pro-image';
