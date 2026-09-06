-- Finance's rev. 16 aligns the parked Seedance 2.0 4K prices with the signed Kie
-- legs: 2910/2183 -> 2108 credits. The rows stay inactive because 4K is not on sale, but
-- production must still carry the signed value so an inactive row cannot drift from
-- the seed and later become stale when the route is opened.
WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev16-001', 'seedance-2-0', '4K', false, false, 'second', 2108, 5, false, 'any', 0, NULL::integer, 'rev16:Сетка FX стр.15/Сетка FX стр.66', false),
  ('pricing-rev16-002', 'seedance-2-0-reference-to-video', '4K', true, false, 'second', 2108, 5, false, 'any', 0, NULL::integer, 'rev16:Сетка FX стр.66', false)
)
INSERT INTO "model_price_points" (
  "id", "model_id", "resolution", "video_input", "audio", "unit_kind",
  "base_credits", "base_units", "flat_rate", "mode", "refs_min", "refs_max", "source_ref", "is_active"
)
SELECT
  id,
  model_id,
  resolution,
  video_input,
  audio,
  unit_kind::"unit_kind",
  base_credits,
  base_units,
  flat_rate,
  mode,
  refs_min,
  refs_max,
  source_ref,
  is_active
FROM price_rows
ON CONFLICT ("model_id", "resolution", "video_input", "audio", "mode", "refs_min") DO UPDATE
SET
  "unit_kind" = EXCLUDED."unit_kind",
  "base_credits" = EXCLUDED."base_credits",
  "base_units" = EXCLUDED."base_units",
  "flat_rate" = EXCLUDED."flat_rate",
  "refs_max" = EXCLUDED."refs_max",
    "source_ref" = EXCLUDED."source_ref",
    "is_active" = EXCLUDED."is_active";

-- `credit_cost_per_unit` is a legacy ceiling, but it is still derived from the
-- dearest priced row, including inactive rows. Both Seedance 4K selectors now
-- carry 2108 / 5 = 422 credits per second.
UPDATE "models" SET "credit_cost_per_unit" = 422 WHERE "id" = 'seedance-2-0';
UPDATE "models" SET "credit_cost_per_unit" = 422 WHERE "id" = 'seedance-2-0-reference-to-video';
