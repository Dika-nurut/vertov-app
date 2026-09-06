-- Carry finance's signed rev. 9 prices to databases that already applied the v14
-- catalogue. This deliberately updates active rows: changing the live charge is the
-- purpose of the migration, and a configuration that cannot be matched is omitted
-- rather than estimated.
--
-- Kling 720p and Gemini Omni previously stored model-managed/generated audio under
-- audio=false. Keep those historical rows for additive migration history, but make
-- them inactive before installing the export's audio=true configurations.
UPDATE "model_price_points"
SET "is_active" = false
WHERE "video_input" = false
  AND "audio" = false
  AND (
    ("model_id" = 'kling-v3-0-std' AND "resolution" = '720p')
    OR ("model_id" = 'gemini-omni-flash' AND "resolution" = 'default')
  );

WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, flat_rate, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev9-001', 'seedance-2-0', '720p', false, false, 'second', 323, 5, false, 'rev9:Сетка FX стр.17', true),
  ('pricing-rev9-002', 'seedance-2-0', '480p', false, false, 'second', 145, 5, false, 'rev9:Сетка FX стр.18', true),
  ('pricing-rev9-003', 'seedance-2-0-fast', '480p', false, false, 'second', 118, 5, false, 'rev9:Сетка FX стр.20', true),
  ('pricing-rev9-004', 'happyhorse-1-1', '720p', false, false, 'second', 212, 5, false, 'rev9:Сетка FX стр.21', true),
  ('pricing-rev9-005', 'wan-2-7', '720p', false, false, 'second', 163, 5, false, 'rev9:Сетка FX стр.25', true),
  ('pricing-rev9-006', 'wan-2-7', '1080p', false, false, 'second', 244, 5, false, 'rev9:Сетка FX стр.26', true),
  ('pricing-rev9-007', 'kling-v3-0-std', '720p', false, true, 'second', 203, 5, false, 'rev9:Сетка FX стр.27', true),
  ('pricing-rev9-008', 'grok-imagine-video', '720p', false, false, 'second', 69, 6, false, 'rev9:Сетка FX стр.28', true),
  ('pricing-rev9-009', 'grok-imagine-video', '480p', false, false, 'second', 37, 6, false, 'rev9:Сетка FX стр.29', true),
  ('pricing-rev9-010', 'gemini-omni-flash', 'default', false, true, 'second', 257, 8, false, 'rev9:Сетка FX стр.30', true),
  ('pricing-rev9-011', 'gemini-3-1-flash-image', '1K', false, false, 'image', 17, 1, false, 'rev9:Сетка FX стр.32', true),
  ('pricing-rev9-012', 'gemini-3-1-flash-image', '2K', false, false, 'image', 23, 1, false, 'rev9:Сетка FX стр.47', true),
  ('pricing-rev9-013', 'gemini-3-1-flash-image', '4K', false, false, 'image', 28, 1, false, 'rev9:Сетка FX стр.48', true),
  ('pricing-rev9-014', 'gemini-3-1-flash-lite-image', 'default', false, false, 'image', 9, 1, false, 'rev9:Сетка FX стр.33', true),
  ('pricing-rev9-015', 'seedream-5-0-pro', '2K', false, false, 'image', 31, 1, false, 'rev9:Сетка FX стр.41', true),
  ('pricing-rev9-016', 'flux-2-pro', 'default', false, false, 'image', 11, 1, false, 'rev9:Сетка FX стр.43', true),
  ('pricing-rev9-017', 'seedance-2-0-reference-to-video', '4K', true, false, 'second', 2911, 5, false, 'rev9:Сетка FX стр.66', false),
  ('pricing-rev9-018', 'seedance-2-0-reference-to-video', '1080p', true, false, 'second', 776, 5, false, 'rev9:Сетка FX стр.65', false),
  ('pricing-rev9-019', 'seedance-2-0-reference-to-video', '720p', true, false, 'second', 323, 5, false, 'rev9:Сетка FX стр.64', false),
  ('pricing-rev9-020', 'seedance-2-0-reference-to-video', '480p', true, false, 'second', 145, 5, false, 'rev9:Сетка FX стр.63', false),
  ('pricing-rev9-021', 'seedance-2-0-fast-reference-to-video', '720p', true, false, 'second', 259, 5, false, 'rev9:Сетка FX стр.68', false),
  ('pricing-rev9-022', 'seedance-2-0-fast-reference-to-video', '480p', true, false, 'second', 118, 5, false, 'rev9:Сетка FX стр.67', false),
  ('pricing-rev9-023', 'seedance-2-0-reference-to-video', '720p', false, false, 'second', 323, 5, false, 'rev9:Сетка FX стр.64', true),
  ('pricing-rev9-024', 'seedance-2-0-reference-to-video', '480p', false, false, 'second', 145, 5, false, 'rev9:Сетка FX стр.63', true),
  ('pricing-rev9-025', 'seedance-2-0-fast-reference-to-video', '480p', false, false, 'second', 118, 5, false, 'rev9:Сетка FX стр.67', true)
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

-- Keep the legacy non-billing display ceiling at max(ceil(base_credits/base_units))
-- after the rev. 9 rows above. These values are not a fallback or an estimate.
UPDATE "models" SET "credit_cost_per_unit" = 31 WHERE "id" = 'seedream-5-0-pro';
UPDATE "models" SET "credit_cost_per_unit" = 583 WHERE "id" = 'seedance-2-0-reference-to-video';
UPDATE "models" SET "credit_cost_per_unit" = 12 WHERE "id" = 'grok-imagine-video';
UPDATE "models" SET "credit_cost_per_unit" = 49 WHERE "id" = 'wan-2-7';
UPDATE "models" SET "credit_cost_per_unit" = 11 WHERE "id" = 'flux-2-pro';
UPDATE "models" SET "credit_cost_per_unit" = 28 WHERE "id" = 'gemini-3-1-flash-image';
UPDATE "models" SET "credit_cost_per_unit" = 9 WHERE "id" = 'gemini-3-1-flash-lite-image';
UPDATE "models" SET "credit_cost_per_unit" = 33 WHERE "id" = 'gemini-omni-flash';
