-- Rev. 23 (2026-09-25): Seedance 2.0 Mini on Pixazo — the free/economy video tier.
-- Catalogue identity + two price points, all INACTIVE: the playbook activates a new
-- vendor row only after its paid smoke (task id + observed charge) is attached.
-- Credits come from the workbook grid rows 111/112 (36 / 77 per 5 s; 25 % floor at
-- the 4 s worst duration, which Pixazo bills as 5 s). Idempotent; mirrors
-- packages/db/seed/models.ts and price-points.ts.
INSERT INTO "models" (
  "id", "provider", "family", "variant", "kind", "is_active", "tier_min", "unit_kind",
  "expected_latency_ms_p50", "expected_latency_ms_p95", "max_duration_seconds",
  "max_resolution", "provider_model_id", "provider_endpoint", "capabilities"
) VALUES (
  'seedance-2-0-mini', 'byteplus', 'seedance', '2.0-mini', 'video', false, 'free', 'second',
  120000, 300000, 15, '720p', 'seedance-2-0-mini',
  'https://gateway.pixazo.ai/seedance-2-0-mini/text-to-video',
  '{"durations":[4,5,6,7,8,9,10,11,12,13,14,15],"resolutions":["480p","720p"],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"audio":true,"frames":["first","last"],"forceGateway":"pixazo","default_resolution":"480p","priceUsdPerUnit":0.0302}'::jsonb
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units,
  flat_rate, mode, refs_min, refs_max, source_ref, is_active
) AS (
  VALUES
    ('pricing-0113-001', 'seedance-2-0-mini', '480p', false, false, 'second', 36, 5, false, 'any', 0, NULL::integer, 'rev23:Сетка FX стр.111', false),
    ('pricing-0113-002', 'seedance-2-0-mini', '720p', false, false, 'second', 77, 5, false, 'any', 0, NULL::integer, 'rev23:Сетка FX стр.112', false)
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
  "source_ref" = EXCLUDED."source_ref";
