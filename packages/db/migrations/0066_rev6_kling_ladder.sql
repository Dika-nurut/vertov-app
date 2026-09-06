-- Kling's full ladder arrives with the rev. 6+ export: kie serves 1080p and 4K, while
-- OpenRouter carries 720p only. The earlier "withdraw 1080p/4K, they do not exist on
-- our route" was wrong about the vendor, right about us.
--
-- BOTH ROWS LAND INACTIVE, and the blocker is the ROUTE, not the price. `kling-v3-0-std`
-- points at OpenRouter's `kwaivgi/kling-v3.0-std`, and `kie-adapter.ts` has no Kling
-- route at all. Selling a rung the adapter cannot call is the flux defect repeated.
-- Carrying the price now means wiring kie is a flag flip rather than a trip back to the
-- workbook.
--
-- WHAT IS DELIBERATELY NOT HERE: Veo 4K (750 / 365 / 305). Rev. 6 moved the Veo family
-- to «за клип» — one price for any duration, because that is how the vendor sells it —
-- and `unit_kind` has no 'clip' value yet. Writing those rows as 'second' would store a
-- number that means something different from what finance signed: a 4-second request
-- would bill 375 against a full clip cost. A row we know to be wrong is worse than a
-- row that is absent, because absent fails closed and wrong fails silently. Veo 4K
-- lands with the 'clip' enum value, in its own migration, as it must.
--
-- Audio: these two rungs are the audio-ON rates (274 and 679), which is what the route
-- actually produces — the OpenRouter adapter defaults `generate_audio` to true. The
-- audio-OFF rung (1080p at 183) waits for the price selector to grow an audio axis;
-- storing it now would create two rows nothing downstream can tell apart.

WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, source_ref, is_active
) AS (
  VALUES
  ('pricing-rev6-001', 'kling-v3-0-std', '1080p', false, true, 'second', 274, 5, 'rev6:Сетка FX стр.70', false),
  ('pricing-rev6-002', 'kling-v3-0-std', '4K', false, true, 'second', 679, 5, 'rev6:Сетка FX стр.71', false)
)
INSERT INTO "model_price_points" (
  "id", "model_id", "resolution", "video_input", "audio", "unit_kind", "base_credits", "base_units", "source_ref", "is_active"
)
SELECT id, model_id, resolution, video_input, audio, unit_kind::"unit_kind", base_credits, base_units, source_ref, is_active
FROM price_rows
ON CONFLICT ("model_id", "resolution", "video_input", "audio") DO UPDATE
SET
  "base_credits" = EXCLUDED."base_credits",
  "base_units" = EXCLUDED."base_units",
  "unit_kind" = EXCLUDED."unit_kind",
  "source_ref" = EXCLUDED."source_ref"
-- `is_active` is deliberately absent from the SET list, and the predicate below repeats
-- the intent: a reseed or a re-run must never switch off a row an operator turned on.
-- The first version of this migration wrote `is_active = EXCLUDED.is_active`
-- unconditionally, which contradicts the seed script's own careful policy two files over.
WHERE "model_price_points"."is_active" = false;

-- `credit_cost_per_unit` is the legacy catalogue CEILING — a display field that must
-- never understate a model's dearest configuration. A 4K rung raises it, and inactive
-- rungs count: they are off because we cannot serve them yet, not because they are
-- unsellable. Kling only; the Veo bumps belong with the Veo rows.
UPDATE "models" SET "credit_cost_per_unit" = 136 WHERE "id" = 'kling-v3-0-std';
