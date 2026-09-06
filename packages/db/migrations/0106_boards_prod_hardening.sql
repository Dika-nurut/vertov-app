-- Boards production hardening: reversible trash, corrupt-state support, and
-- append-only version history. All changes are additive so existing boards
-- remain readable during deployment.
ALTER TABLE "boards"
  ADD COLUMN IF NOT EXISTS "trashed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "state_backup" jsonb,
  ADD COLUMN IF NOT EXISTS "state_backup_at" timestamptz;

CREATE INDEX IF NOT EXISTS "boards_user_trash_idx"
  ON "boards" ("user_id", "trashed_at", "updated_at");

DO $$ BEGIN
  CREATE TYPE "board_snapshot_reason" AS ENUM ('autosave', 'manual', 'pre-destructive');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "board_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "board_id" text NOT NULL REFERENCES "boards"("id") ON DELETE CASCADE,
  "rev" integer NOT NULL,
  "state" jsonb NOT NULL,
  "reason" "board_snapshot_reason" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "board_snapshots_board_created_idx"
  ON "board_snapshots" ("board_id", "created_at", "id");
