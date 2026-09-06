-- Finance's signed rev. 13. Two price rows move and one is added.
--
-- `ON CONFLICT` names the SIX-column key (`0079` widened it with `mode` and `refs_min`).
-- 0083 shipped with `0070`'s four-column tuple, Postgres refused the whole statement
-- with 42P10, and CI died on the isolated-database migrate. Copy the NEWEST migration's
-- tuple, never an older one's.
WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
  -- FLUX.2 Pro, 2–8 reference band: 13 → 14. NOT a repricing. OpenRouter bills
  -- $0,03 per MEGAPIXEL and a 1K image is 1,049 MP, so the leg always cost $0,0315 and
  -- 13 credits was 22,4% — under the 25% floor by a rounding both sides had been
  -- reading as a flat per-picture rate. Safe in both directions: if the vendor does
  -- bill flat, 14 credits is 31%.
  ('pricing-rev13-001', 'flux-2-pro', 'default', false, false, 'image', 14, 1, false, 'any', 2, 8, 'rev13:Сетка FX стр.79', true),
  -- FLUX.2 Pro 2K, the new rung, signed against a rate we MEASURED: 7 kie credits at
  -- $0,005 = $0,035, the unit calibrated off the already-signed 1K leg rather than
  -- assumed. 15 and not 14 because 14 lands at 24,0%.
  --
  -- Ships INACTIVE, and the blocker is a BAND NAME rather than a price. rev. 13 bands
  -- the cheap rung `default` while banding this one `2K`; `priceSelectorFromParams`
  -- keys on the model's DECLARED resolution list, so declaring ['1K','2K'] would make
  -- every 1K request key on '1K', find no row, and be refused — the same failure the
  -- Gemini Omni 720p ruling produced a day earlier. Finance is asked to re-band
  -- `default` → `1K` in rev. 14; the adapter's hardcoded `resolution: '1K'` comes off
  -- in that same change, together with the row going active.
  ('pricing-rev13-002', 'flux-2-pro', '2K', false, false, 'image', 15, 1, false, 'any', 0, NULL::integer, 'rev13:Сетка FX стр.104', false)
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

-- `credit_cost_per_unit` is `ceil(base_credits / base_units)` over the dearest priced
-- rung and feeds the admin panel's margin figure, so it moves with the prices above.
-- flux-2-pro's dearest rung is now the 2K one at 15/1 — priced and signed even though
-- it is not yet sellable, which is the correct ceiling for a margin report.
--
-- Deliberately NOT touched: the fifteen veo rows. rev. 13 moved their `Количество`
-- from 1 to 8, and that is an error in the export rather than a change to absorb —
-- finance's own `Себест ₽` on the same rows still reads one clip (veo-3-1 720p:
-- 125,79 ₽ = $1,25 × 100,6315), and the margin reconciles against that one-clip figure.
-- Absorbing it would take veo-3-1 from 597 to 75 and understate every veo margin
-- eightfold. Pinned by value in `rev6-projection.test.ts`; correction asked for rev. 14.
UPDATE "models" SET "credit_cost_per_unit" = 15 WHERE "id" = 'flux-2-pro';
