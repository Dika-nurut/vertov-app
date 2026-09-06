-- The five rows the widened key exists for.
--
-- 0077 added `mode` and the reference band and changed no price: every existing row
-- took ('any', 0), which matches any request. These are the rows that DO move a
-- price — the configurations finance rev. 10 signed above the one we charge today,
-- and which the four-column key had no way to say.
--
--   wan-2-7 720p  i2v      163 → 214   (5 s)
--   wan-2-7 1080p i2v      244 → 321   (5 s)
--   flux-2-pro    refs 2–8  11 → 13
--   seedream-5-0-pro 1K refs 2–10  16(+perItem) → 24
--   seedream-5-0-pro 2K refs 2–10  31(+perItem) → 38
--
-- Wan is a MODE difference for a reason worth stating: the per-second vendor rate is
-- not what moves. Text-to-video runs kie-primary at $0.08/$0.12; the kie route is
-- text-to-video only, so a framed shot has to run on OpenRouter at $0.10/$0.15. Same
-- clip, dearer leg, and the credits restore the margin on the leg that serves.
--
-- Kling and Grok are deliberately NOT here: rev. 11 signs their i2v rows at exactly
-- the t2v numbers (270/180 and 69/37), because both modes run on the same single leg.
-- A mode row that repeats the price it overrides is a second row to keep in sync for
-- no gain — «a price difference between modes is only real when the modes route
-- differently» (rev. 11). Seedream 4.5's i2i rows are the same case.
--
-- The two Seedream `per_item` terms come OUT in the same statement that adds the
-- band. That term was the stand-in for this band — it metered kie's $0.0025 per input
-- image past the first so a ten-reference edit could not run at a loss. The band
-- prices the same worst case as ONE flat number, so leaving both would charge the
-- surcharge twice; the kernel refuses a row carrying both rather than adding them.

WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units,
  flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev10-101', 'wan-2-7', '720p', false, false, 'second', 214, 5, false, 'i2v', 0, NULL::integer, 'rev10:Сетка FX стр.77', true),
  ('pricing-rev10-102', 'wan-2-7', '1080p', false, false, 'second', 321, 5, false, 'i2v', 0, NULL::integer, 'rev10:Сетка FX стр.78', true),
  ('pricing-rev10-103', 'flux-2-pro', 'default', false, false, 'image', 13, 1, false, 'any', 2, 8, 'rev10:Сетка FX стр.79', true),
  ('pricing-rev10-104', 'seedream-5-0-pro', '1K', false, false, 'image', 24, 1, false, 'any', 2, 10, 'rev10:Сетка FX стр.61', true),
  ('pricing-rev10-105', 'seedream-5-0-pro', '2K', false, false, 'image', 38, 1, false, 'any', 2, 10, 'rev10:Сетка FX стр.62', true)
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

UPDATE "model_price_points"
SET "per_item" = NULL
WHERE "model_id" = 'seedream-5-0-pro'
  AND "refs_min" = 0;

-- The legacy `credit_cost_per_unit` ceiling follows the dearest rung actually sold,
-- and three models just gained a dearer one. It is not a sell price — the resolver
-- never reads it — but an unrelated legacy display that does read it must not quote
-- under what we charge.
--
--   wan-2-7          1080p i2v 321 credits / 5 s → ceil(64.2) = 65
--   flux-2-pro       the 2–8 reference band      → 13
--   seedream-5-0-pro 2K, 2–10 references         → 38
UPDATE "models" SET "credit_cost_per_unit" = 65 WHERE "id" = 'wan-2-7';
UPDATE "models" SET "credit_cost_per_unit" = 13 WHERE "id" = 'flux-2-pro';
UPDATE "models" SET "credit_cost_per_unit" = 38 WHERE "id" = 'seedream-5-0-pro';
