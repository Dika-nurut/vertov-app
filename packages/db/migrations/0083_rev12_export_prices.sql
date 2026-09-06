-- Carry finance's signed rev. 12 corrections to databases that already applied the
-- v14 catalogue and rev. 9 export. This deliberately updates the existing rows through
-- their unique configuration key: six prices were corrected, while every other field
-- stays as the row already carries. The two `rev12-зеркало:` rows are owner-ruling
-- mirrors, not finance's signature: rev. 12 still exports 776 for those configurations.

-- `ON CONFLICT` below names the SIX-column key. The four-column one this file first
-- carried was copied from 0070 and no longer exists: 0079 widened the unique index with
-- `mode` and `refs_min` when the price key gained a mode and a reference band, so the
-- old tuple matches no constraint and Postgres refuses the statement outright. CI caught
-- it on the isolated-database migrate; it never reached a deployed database.
WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev12-001', 'gemini-omni-flash', 'default', false, true, 'second', 273, 8, false, 'any', 0, NULL::integer, 'rev12:Сетка FX стр.30', true),
  ('pricing-rev12-002', 'veo-3-1-lite', '4K', false, true, 'second', 304, 1, true, 'any', 0, NULL::integer, 'rev12:Сетка FX стр.74', false),
  ('pricing-rev12-003', 'seedance-2-0', '1080p', false, false, 'second', 775, 5, false, 'any', 0, NULL::integer, 'rev12:Сетка FX!AA16/AB16', true),
  ('pricing-rev12-004', 'seedance-2-0-reference-to-video', '4K', true, false, 'second', 2910, 5, false, 'any', 0, NULL::integer, 'rev12:Сетка FX стр.66', false),
  ('pricing-rev12-005', 'seedance-2-0-reference-to-video', '1080p', true, false, 'second', 775, 5, false, 'any', 0, NULL::integer, 'rev12-зеркало:Сетка FX стр.65', false),
  ('pricing-rev12-006', 'seedance-2-0-reference-to-video', '1080p', false, false, 'second', 775, 5, false, 'any', 0, NULL::integer, 'rev12-зеркало:Сетка FX!AA16/AB16', true)
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

-- The legacy per-unit ceiling on `models` is DERIVED from the dearest priced rung
-- (ceil(base_credits / base_units)) and feeds the admin panel's margin figure —
-- `1 - (usd * fx) / (credit_cost_per_unit * credit_rub)`. 0070 moved it in the same
-- migration as its prices for exactly this reason; leaving it behind here would make
-- the margin report quietly understate three models against prices this file changes.
--   gemini-omni-flash                273/8 -> 35 (was 33)
--   seedance-2-0-reference-to-video 2910/5 -> 582 (was 583)
--   veo-3-1-lite                     304/1 -> 304 (was 305)
UPDATE "models" SET "credit_cost_per_unit" = 35 WHERE "id" = 'gemini-omni-flash';
UPDATE "models" SET "credit_cost_per_unit" = 582 WHERE "id" = 'seedance-2-0-reference-to-video';
UPDATE "models" SET "credit_cost_per_unit" = 304 WHERE "id" = 'veo-3-1-lite';

-- Gemini Omni is a 720p product (owner ruling 2026-08-09) and `max_resolution` read
-- '1080p'. Only that column moves. `capabilities.resolutions` stays the EMPTY array:
-- empty is the contract «one fixed output, no customer lever», and it is what pins the
-- price key to the 'default' band finance signs. Writing ["720p"] there would make
-- `priceSelectorFromParams` read the request instead, and a 720p request would find no
-- row — omni would stop billing. The customer-facing half of this ruling is a UI fix
-- (GenerateClient no longer reads an empty list as missing metadata), not a data one.
UPDATE "models" SET "max_resolution" = '720p' WHERE "id" = 'gemini-omni-flash';
