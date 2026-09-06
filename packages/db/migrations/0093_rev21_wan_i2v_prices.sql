-- Finance rev. 21 reprices wan-2-7 i2v onto the kie leg: 214 -> 163 (720p) and
-- 321 -> 244 (1080p), −24% on both.
--
-- This is the cut rev. 18 already made and had to roll back, because the fact under it
-- was wrong: I reported that keyframed Wan jobs ran on kie when the kie leg was in fact
-- refusing every job with frames, and OpenRouter was serving them. The slug
-- `wan/2-7-image-to-video` was wired on 2026-08-11 (`3da9cd18`) and a paid call through
-- the production adapter — task d1f623742cc98f2af897ab45048eb63d, USD 0,40 for 5 s at
-- 720p — confirmed the rate to the cent. The fact now exists.
--
-- The new prices are not new numbers: they are the t2v twins' prices, which is what
-- finance means by "both rows now mirror their t2v twins by reference, so they cannot
-- drift apart again". Same model, same leg, same $0,08/$0,12 per second — the only thing
-- that ever differed was which gateway we believed was serving.
--
-- Written as an upsert on the SIX-column key from 0079, not as an UPDATE by id, because
-- `pricing-catalogue-migration-parity.test.ts` reconstructs the production catalog by
-- scanning forward migrations for exactly this `price_rows` shape. An UPDATE is
-- invisible to it, and the row would read as a seed-only change production never
-- receives — the same class of gap the flux routing fix was.
WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev21-001', 'wan-2-7', '720p', false, false, 'second', 163, 5, false, 'i2v', 0, NULL::integer, 'rev21:Сетка FX стр.77', true),
  ('pricing-rev21-002', 'wan-2-7', '1080p', false, false, 'second', 244, 5, false, 'i2v', 0, NULL::integer, 'rev21:Сетка FX стр.78', true)
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

-- The legacy per-unit ceiling has to follow the dearest priced rung down with it.
-- `models.credit_cost_per_unit` is the flat pre-ladder rate, and the guardrail in
-- `model-margin-guardrail.test.ts` pins it to ceil(dearest rung / base units): the
-- dearest wan rung was 321/5 s = 65, and is now 244/5 s = 49. Left at 65 it would quote
-- a 33% surcharge on any path that still reads the flat rate.
UPDATE "models" SET "credit_cost_per_unit" = 49 WHERE "id" = 'wan-2-7';
