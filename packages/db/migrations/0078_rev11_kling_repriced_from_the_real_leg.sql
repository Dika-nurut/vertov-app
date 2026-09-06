-- Finance rev. 11: Kling repriced from the leg that actually exists.
--
-- Rev. 10 priced Kling 720p from a Kie primary at $0.07/$0.10 per second. There is
-- no Kie route for Kling anywhere — no slug in the kie adapter, no gateway override,
-- no fallback, and the route contract declares OpenRouter only. Every job ran on
-- OpenRouter at $0.084/$0.126, where the export's own arithmetic gives 5.16% and
-- 0.48% against a 25% target. The signed 142/203 were, in all but name, cost.
--
-- Rev. 11 re-derives both from the real leg: 180 without audio, 270 with. The
-- workbook types these ИСПРАВЛЕНИЕ — цена от несуществующей ноги, not a repricing.
--
-- Audio is a user toggle on this model, so BOTH states carry a row. Without the
-- quiet one a silent request takes the audio price, which is the same class of
-- defect one level down.
--
-- 1080p and 4K are WITHDRAWN. The catalogue declares `resolutions: ['720p']`, so
-- those rows priced rungs that were never for sale. They are deactivated rather
-- than deleted: additive history, and the day a route serves them the price is
-- there to be re-derived rather than reinvented.
--
-- The legacy `credit_cost_per_unit` ceiling drops 136 → 54 with them: it must track
-- the dearest rung actually sold (270 credits over 5 seconds), or an unrelated
-- legacy display quotes a rung that no longer exists.

UPDATE "model_price_points"
SET "is_active" = false
WHERE "model_id" = 'kling-v3-0-std'
  AND "resolution" IN ('1080p', '4K');

WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units,
  flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev11-001', 'kling-v3-0-std', '720p', false, true, 'second', 270, 5, false, 'any', 0, NULL::integer, 'rev11:Сетка FX стр.27', true),
  ('pricing-rev11-002', 'kling-v3-0-std', '720p', false, false, 'second', 180, 5, false, 'any', 0, NULL::integer, 'rev11:Сетка FX стр.27б', true)
)
INSERT INTO "model_price_points" (
  "id", "model_id", "resolution", "video_input", "audio", "unit_kind",
  "base_credits", "base_units", "flat_rate", "mode", "refs_min", "refs_max",
  "source_ref", "is_active"
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

UPDATE "models"
SET "credit_cost_per_unit" = 54
WHERE "id" = 'kling-v3-0-std';
