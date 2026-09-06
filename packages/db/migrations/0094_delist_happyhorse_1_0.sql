-- HappyHorse 1.0 delisting + 1.1 repricing per workbook v14 03_08.
-- Source: docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx
--         'Сетка FX' rows 21-24 + 'ЖУРНАЛ ЦЕН' 2026-08-03.
--> statement-breakpoint
UPDATE "models"
SET
  "is_active" = false,
  "credit_cost_per_unit" = 73
WHERE "id" = 'happyhorse-1-0';--> statement-breakpoint
UPDATE "models"
SET
  "credit_cost_per_unit" = 55
WHERE "id" = 'happyhorse-1-1';--> statement-breakpoint

-- Production deployments apply migrations but do not rerun the seed. Move the
-- two legacy inactive demo presets to the replacement model as well.
UPDATE "preset_packs"
SET "model_id" = 'happyhorse-1-1'
WHERE "model_id" = 'happyhorse-1-0'
  AND "slug" IN (
    'demo-happyhorse-1-0-inflate-kie',
    'demo-happyhorse-1-0-inflate-atlas'
  );--> statement-breakpoint

WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units,
  flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
    ('pricing-0094-001', 'happyhorse-1-1', '720p', false, false, 'second', 212, 5, false, 'any', 0, NULL::integer, 'rev9:Сетка FX стр.21', true),
    ('pricing-0094-002', 'happyhorse-1-1', '1080p', false, false, 'second', 274, 5, false, 'any', 0, NULL::integer, 'Сетка FX!AA22/AB22', true),
    ('pricing-0094-003', 'happyhorse-1-0', '720p', false, false, 'second', 284, 5, false, 'any', 0, NULL::integer, 'Сетка FX!AA23/AB23', false),
    ('pricing-0094-004', 'happyhorse-1-0', '1080p', false, false, 'second', 365, 5, false, 'any', 0, NULL::integer, 'Сетка FX!AA24/AB24', false)
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
ON CONFLICT ("model_id", "resolution", "video_input", "audio", "mode", "refs_min") DO UPDATE SET
  "unit_kind" = EXCLUDED."unit_kind",
  "base_credits" = EXCLUDED."base_credits",
  "base_units" = EXCLUDED."base_units",
  "flat_rate" = EXCLUDED."flat_rate",
  "refs_max" = EXCLUDED."refs_max",
  "source_ref" = EXCLUDED."source_ref",
  "is_active" = EXCLUDED."is_active";
