-- Studio multi-project: drop the one-per-user cap and add title + created_at so
-- each user can keep many named editor projects (mirrors `boards`). Existing
-- single rows become each user's first project (default title). The quick
-- `/studio` editor + generate/boards hand-off keep using a reserved "scratch"
-- row (deterministic id `scratch-<userId>`), now upserted by primary key.
ALTER TABLE "studio_projects" DROP CONSTRAINT IF EXISTS "studio_projects_user_id_key";
ALTER TABLE "studio_projects" DROP CONSTRAINT IF EXISTS "studio_projects_user_id_unique";
ALTER TABLE "studio_projects" ADD COLUMN IF NOT EXISTS "title" text DEFAULT 'Новый проект' NOT NULL;
ALTER TABLE "studio_projects" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "studio_projects_user_id_idx" ON "studio_projects" ("user_id");
