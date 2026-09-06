-- Finance's rev. 19 signs two new Flux 2K configurations. They share the measured
-- 15-credit Kie rate, but each needs its own six-column key so i2i and the 2–8
-- reference band cannot fall through to an unrelated plain row.
WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev19-001', 'flux-2-pro', '2K', false, false, 'image', 15, 1, false, 'i2i', 0, NULL::integer, 'rev19:Сетка FX стр.105', true),
  ('pricing-rev19-002', 'flux-2-pro', '2K', false, false, 'image', 15, 1, false, 'any', 2, 8, 'rev19:Сетка FX стр.106', true)
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
