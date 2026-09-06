-- Owner ruling 2026-08-26: retire the temporary Flux 1K 2–8-reference premium.
-- Kie has served this band since the 2026-08-09 adapter fix, so the constraint
-- behind the 14-credit ruling is gone. The plain signed 1K row remains active at
-- exactly 11 credits; the historical band row stays for finance audit.
UPDATE "model_price_points"
SET "is_active" = false
WHERE "model_id" = 'flux-2-pro'
  AND "resolution" = '1K'
  AND "video_input" = false
  AND "audio" = false
  AND "mode" = 'any'
  AND "refs_min" = 2
  AND "refs_max" = 8
  AND "is_active" = true;

-- The plain 1K row is the only sellable Flux 1K configuration after this ruling.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "model_price_points"
    WHERE "model_id" = 'flux-2-pro'
      AND "resolution" = '1K'
      AND "video_input" = false
      AND "audio" = false
      AND "mode" = 'any'
      AND "refs_min" = 0
      AND "refs_max" IS NULL
      AND "is_active" = true
      AND "base_credits" = 11
  ) THEN
    RAISE EXCEPTION 'plain flux-2-pro 1K row must remain active at 11 credits';
  END IF;
END
$$;
