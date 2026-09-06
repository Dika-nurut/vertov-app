-- Admin takedown is durable: the owner must not be able to republish the same
-- item after moderation has removed it from the public surfaces.
ALTER TABLE "gallery_items"
  ADD COLUMN IF NOT EXISTS "moderation_takedown_at" timestamp with time zone;
