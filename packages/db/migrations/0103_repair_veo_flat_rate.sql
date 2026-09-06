-- Repair the production rows created by 0069_rev9_veo_clip_prices.
--
-- 0069 declared `flat_rate = true` in its VALUES CTE but omitted the column from
-- the INSERT column list. PostgreSQL therefore used the column default (`false`)
-- for the six active and three inactive Veo 720p/1080p/4K rows. The current seed
-- is correct, but production deployments apply migrations without rerunning seed;
-- leave the historical migration intact and repair its persisted result forward.
UPDATE "model_price_points"
SET "flat_rate" = true
WHERE "model_id" IN ('veo-3-1', 'veo-3-1-fast', 'veo-3-1-lite')
  AND "resolution" IN ('720p', '1080p', '4K')
  AND "video_input" = false
  AND "audio" = true
  AND "mode" = 'any'
  AND "refs_min" = 0
  AND "refs_max" IS NULL
  AND "base_units" = 1
  AND "flat_rate" = false;

DO $$
DECLARE
  veo_rows integer;
BEGIN
  SELECT count(*)
  INTO veo_rows
  FROM "model_price_points"
  WHERE "model_id" IN ('veo-3-1', 'veo-3-1-fast', 'veo-3-1-lite')
    AND "resolution" IN ('720p', '1080p', '4K')
    AND "video_input" = false
    AND "audio" = true
    AND "mode" = 'any'
    AND "refs_min" = 0
    AND "refs_max" IS NULL
    AND "base_units" = 1;

  IF veo_rows <> 9 OR EXISTS (
    SELECT 1
    FROM "model_price_points"
    WHERE "model_id" IN ('veo-3-1', 'veo-3-1-fast', 'veo-3-1-lite')
      AND "resolution" IN ('720p', '1080p', '4K')
      AND "video_input" = false
      AND "audio" = true
      AND "mode" = 'any'
      AND "refs_min" = 0
      AND "refs_max" IS NULL
      AND "base_units" = 1
      AND "flat_rate" IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'Veo flat-rate repair expected 9 rows with flat_rate=true, found %', veo_rows;
  END IF;
END
$$;
