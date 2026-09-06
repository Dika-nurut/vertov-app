-- Rev. 9 prices Veo per clip: one charge for any positive duration. The six
-- reachable 720p/1080p configurations stay active; the three 4K configurations
-- stay inactive because `packages/providers/byteplus/src/kie-adapter.ts` refuses
-- them until the required POST `/veo/get-4k-video` two-step is wired.
--
-- Earlier rows encoded model-managed audio as false. Retain those historical rows
-- but take them off the live path before inserting the export's actual audio=true
-- configurations; otherwise both identities would remain active at different prices.
UPDATE "model_price_points"
SET "is_active" = false
WHERE "model_id" IN ('veo-3-1', 'veo-3-1-fast', 'veo-3-1-lite')
  AND "resolution" IN ('720p', '1080p')
  AND "video_input" = false
  AND "audio" = false;

WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, flat_rate, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev9-veo-001', 'veo-3-1', '720p', false, true, 'second', 597, 1, true, 'rev9:Сетка FX стр.9', true),
  ('pricing-rev9-veo-002', 'veo-3-1', '1080p', false, true, 'second', 597, 1, true, 'rev9:Сетка FX стр.10', true),
  ('pricing-rev9-veo-003', 'veo-3-1-fast', '720p', false, true, 'second', 122, 1, true, 'rev9:Сетка FX стр.11', true),
  ('pricing-rev9-veo-004', 'veo-3-1-fast', '1080p', false, true, 'second', 132, 1, true, 'rev9:Сетка FX стр.12', true),
  ('pricing-rev9-veo-005', 'veo-3-1-lite', '720p', false, true, 'second', 66, 1, true, 'rev9:Сетка FX стр.13', true),
  ('pricing-rev9-veo-006', 'veo-3-1-lite', '1080p', false, true, 'second', 71, 1, true, 'rev9:Сетка FX стр.14', true),
  ('pricing-rev9-veo-007', 'veo-3-1', '4K', false, true, 'second', 750, 1, true, 'rev9:Сетка FX стр.72', false),
  ('pricing-rev9-veo-008', 'veo-3-1-fast', '4K', false, true, 'second', 365, 1, true, 'rev9:Сетка FX стр.73', false),
  ('pricing-rev9-veo-009', 'veo-3-1-lite', '4K', false, true, 'second', 305, 1, true, 'rev9:Сетка FX стр.74', false)
)
INSERT INTO "model_price_points" (
  "id", "model_id", "resolution", "video_input", "audio", "unit_kind",
  "base_credits", "base_units", "source_ref", "is_active"
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
  source_ref,
  is_active
FROM price_rows
ON CONFLICT ("model_id", "resolution", "video_input", "audio") DO UPDATE
SET
  "unit_kind" = EXCLUDED."unit_kind",
  "base_credits" = EXCLUDED."base_credits",
  "base_units" = EXCLUDED."base_units",
  "flat_rate" = EXCLUDED."flat_rate",
  "source_ref" = EXCLUDED."source_ref",
  "is_active" = EXCLUDED."is_active";

-- Legacy catalogue fields are display ceilings, never a fallback charge. Keep
-- their unit and dearest-rung ceiling coherent with the parametric rows above.
UPDATE "models" SET "credit_cost_per_unit" = 750 WHERE "id" = 'veo-3-1';
UPDATE "models" SET "credit_cost_per_unit" = 365 WHERE "id" = 'veo-3-1-fast';
UPDATE "models" SET "credit_cost_per_unit" = 305 WHERE "id" = 'veo-3-1-lite';
