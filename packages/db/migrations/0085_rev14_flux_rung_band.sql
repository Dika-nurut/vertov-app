-- Finance's rev. 14. NO price moves — the checksums are identical to rev. 13 (128 rows,
-- 27 829 credits, margin 33,32763). Two labels change, and both are labels the billing
-- engine reads.
--
-- 1. flux-2-pro's cheap rung is re-banded `default` → `1K`. rev. 13 added a `2K` rung and
--    left the existing rows on `default`, making flux the first model in the catalogue
--    with a `default` band beside a named one. `priceSelectorFromParams` keys on the
--    model's DECLARED resolution list, so declaring ['1K','2K'] against `default` rows
--    would have keyed every 1K request on '1K', found nothing, and REFUSED the charge —
--    the same break the Gemini Omni 720p ruling produced a day earlier. Finance now
--    asserts at generation that no model may mix `default` with a named rung, so what
--    closes here is the class, not the instance.
-- 2. The `2K` row goes ACTIVE at the 15 credits rev. 13 signed against a MEASURED $0,035
--    (7 kie credits at $0,005, the unit calibrated off the already-signed 1K leg).
--
-- The rung is part of the SIX-column unique key (`0079` widened it with `mode` and
-- `refs_min`), so a re-band is a KEY change and cannot be an in-place UPDATE of the
-- resolution: the row would collide with nothing on the way in, but the old `default`
-- rows would survive underneath as a second priceable identity. Insert the new keys and
-- retire the old ones below.
WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev14-001', 'flux-2-pro', '1K', false, false, 'image', 11, 1, false, 'any', 0, NULL::integer, 'rev14:Сетка FX стр.43', true),
  ('pricing-rev14-002', 'flux-2-pro', '1K', false, false, 'image', 14, 1, false, 'any', 2, 8, 'rev14:Сетка FX стр.79', true),
  ('pricing-rev14-003', 'flux-2-pro', '2K', false, false, 'image', 15, 1, false, 'any', 0, NULL::integer, 'rev14:Сетка FX стр.104', true)
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

-- Retire, do not delete: migrations here are forward-only and additive, and a deactivated
-- row keeps the history of what the rung used to be called. Once the model declares
-- ['1K','2K'] nothing can key on 'default' anyway, so these are unreachable as well as
-- inactive — belt and braces, because "unreachable" is a claim about a resolver and
-- "inactive" is a fact in the row.
UPDATE "model_price_points"
SET "is_active" = false,
    "source_ref" = 'rev14: superseded by the 1K re-band'
WHERE "model_id" = 'flux-2-pro' AND "resolution" = 'default';

-- The declared rung list is the other half of the same change: the resolver refuses a
-- rung the model does not declare, and refuses a declared rung it cannot find a row for.
-- These two statements have to ship together or flux is unsellable between them.
--
-- `aspect_ratios` moves in the same statement, and for a related reason: the contract
-- registry named OpenRouter flux's PRIMARY route until 2026-08-10, while the seed row has
-- said `gatewayOverride: 'kie'` since the owner ruling of 2026-08-04. Scalar menus are
-- derived from the primary route, OpenRouter's image endpoint exposes none, and so the
-- catalogue advertised an empty menu for a leg that has always accepted kie's 7-value
-- aspect enum. Harmless while flux sold one rung with no size control; not harmless the
-- moment it sells two.
UPDATE "models"
SET "capabilities" = "capabilities" || '{"resolutions":["1K","2K"],"aspect_ratios":["1:1","4:3","3:4","16:9","9:16","3:2","2:3"]}'::jsonb
WHERE "id" = 'flux-2-pro';
