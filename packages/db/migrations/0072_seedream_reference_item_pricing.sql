-- 2026-08-02 finance ruling: Seedream Pro charges $0.0025 per reference
-- image after the first. Add the nullable term column without changing the
-- existing price-point key or removing any historical rows.
ALTER TABLE "model_price_points"
  ADD COLUMN IF NOT EXISTS "per_item" jsonb;

UPDATE "model_price_points"
SET "per_item" = '{"included":1,"creditsPerExtra":1}'::jsonb
WHERE "model_id" = 'seedream-5-0-pro'
  AND "resolution" IN ('1K', '2K')
  AND "video_input" = false
  AND "audio" = false;
