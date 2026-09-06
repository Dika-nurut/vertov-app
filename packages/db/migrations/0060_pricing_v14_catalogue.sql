-- v14 catalogue: production deploys run migrations, not the CI-only seed.
-- Keep this forward-only and additive: existing price configurations are corrected
-- through their unique key and never deleted.

WITH model_rows(id, data) AS (
  VALUES
  ('seedream-4-5', '{"id":"seedream-4-5","provider":"byteplus","family":"seedream","variant":"4.5","kind":"image","isActive":true,"tierMin":"free","creditCostPerUnit":20,"unitKind":"image","expectedLatencyMsP50":5000,"expectedLatencyMsP95":12000,"maxResolution":"4096x4096","providerModelId":"doubao-seedream-4.5","providerEndpoint":"/api/v3/images/generations","fallbackGateway":"openrouter","capabilities":{"multi_image":true,"reference":true,"edit":true,"maxRefs":14,"resolutions":["2K","4K"],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"forceGateway":"kie","priceUsdPerUnit":0.0325,"fallbackUsdPerUnit":0.04}}'::jsonb),
  ('seedream-5-0-lite', '{"id":"seedream-5-0-lite","provider":"byteplus","family":"seedream","variant":"5.0-lite","kind":"image","isActive":true,"tierMin":"creator","creditCostPerUnit":17,"unitKind":"image","expectedLatencyMsP50":5000,"expectedLatencyMsP95":12000,"maxResolution":"4096x4096","providerModelId":"seedream-5-0-lite","providerEndpoint":"/api/v1/jobs/createTask","capabilities":{"forceGateway":"kie","reference":true,"maxRefs":10,"resolutions":["2K","3K","4K"],"aspect_ratios":["21:9","16:9","3:2","4:3","1:1","3:4","2:3","9:16"],"priceUsdPerUnit":0.0275}}'::jsonb),
  ('seedream-5-0-pro', '{"id":"seedream-5-0-pro","provider":"byteplus","family":"seedream","variant":"5.0-pro","kind":"image","isActive":true,"tierMin":"creator","creditCostPerUnit":29,"unitKind":"image","expectedLatencyMsP50":5000,"expectedLatencyMsP95":12000,"maxResolution":"2048x2048","providerModelId":"seedream-5-0-pro","providerEndpoint":"/api/v1/jobs/createTask","capabilities":{"forceGateway":"kie","reference":true,"maxRefs":10,"resolutions":["1K","2K"],"aspect_ratios":["21:9","16:9","3:2","4:3","1:1","3:4","2:3","9:16"],"priceUsdPerUnit":0.07}}'::jsonb),
  ('seedance-2-0', '{"id":"seedance-2-0","provider":"byteplus","family":"seedance","variant":"2.0","kind":"video","isActive":true,"tierMin":"creator","creditCostPerUnit":437,"unitKind":"second","expectedLatencyMsP50":240000,"expectedLatencyMsP95":420000,"maxDurationSeconds":15,"maxResolution":"1080p","providerModelId":"seedance-2.0-text-to-video","fallbackGateway":"kie","providerEndpoint":"/api/v3/videos/generations","capabilities":{"durations":[4,5,6,7,8,9,10,11,12,13,14,15],"resolutions":["480p","720p","1080p"],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"audio":true,"frames":["first","last"],"forceGateway":"openrouter","priceUsdPerUnit":0.34,"fallbackUsdPerUnit":0.51}}'::jsonb),
  ('seedance-2-0-fast', '{"id":"seedance-2-0-fast","provider":"byteplus","family":"seedance","variant":"2.0-fast","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":52,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":240000,"maxDurationSeconds":15,"maxResolution":"720p","providerModelId":"seedance-2-0-fast","fallbackGateway":"kie","providerEndpoint":"/api/v3/videos/generations","capabilities":{"durations":[4,5,6,7,8,9,10,11,12,13,14,15],"resolutions":["480p","720p"],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"audio":true,"frames":["first","last"],"forceGateway":"openrouter","priceUsdPerUnit":0.121,"fallbackUsdPerUnit":0.165}}'::jsonb),
  ('seedance-2-0-reference-to-video', '{"id":"seedance-2-0-reference-to-video","provider":"byteplus","family":"seedance","variant":"2.0-reference","kind":"video","isActive":true,"tierMin":"creator","creditCostPerUnit":242,"unitKind":"second","expectedLatencyMsP50":240000,"expectedLatencyMsP95":420000,"maxDurationSeconds":15,"maxResolution":"1080p","providerModelId":"seedance-2.0-reference-to-video","fallbackGateway":"kie","providerEndpoint":"/api/v3/videos/generations","capabilities":{"durations":[4,5,6,7,8,9,10,11,12,13,14,15],"resolutions":["480p","720p","1080p"],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"audio":true,"reference":true,"multi_image":true,"maxRefs":9,"maxVideoRefs":0,"maxAudioRefs":3,"forceGateway":"openrouter","priceUsdPerUnit":0.34,"fallbackUsdPerUnit":0.51}}'::jsonb),
  ('seedance-2-0-fast-reference-to-video', '{"id":"seedance-2-0-fast-reference-to-video","provider":"byteplus","family":"seedance","variant":"2.0-fast-reference","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":52,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":240000,"maxDurationSeconds":15,"maxResolution":"720p","providerModelId":"seedance-2.0-fast-reference-to-video","fallbackGateway":"kie","providerEndpoint":"/api/v3/videos/generations","capabilities":{"durations":[4,5,6,7,8,9,10,11,12,13,14,15],"resolutions":["480p","720p"],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"audio":true,"reference":true,"multi_image":true,"maxRefs":9,"maxVideoRefs":0,"maxAudioRefs":3,"forceGateway":"openrouter","priceUsdPerUnit":0.121,"fallbackUsdPerUnit":0.165}}'::jsonb),
  ('veo-3-1-fast', '{"id":"veo-3-1-fast","provider":"byteplus","family":"Veo","variant":"3.1 Fast","kind":"video","isActive":true,"tierMin":"creator","creditCostPerUnit":30,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":240000,"maxDurationSeconds":8,"maxResolution":"1080p","providerModelId":"google/veo-3.1-fast","providerEndpoint":"/videos","gatewayOverride":"kie","capabilities":{"audio":true,"reference":false,"frames":["first","last"],"durations":[4,6,8],"resolutions":["720p","1080p"],"aspect_ratios":["16:9","9:16"],"passthrough":[],"priceUsdPerUnit":0.040625}}'::jsonb),
  ('veo-3-1', '{"id":"veo-3-1","provider":"byteplus","family":"Veo","variant":"3.1","kind":"video","isActive":true,"tierMin":"creator","creditCostPerUnit":115,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":300000,"maxDurationSeconds":8,"maxResolution":"1080p","providerModelId":"google/veo-3.1","providerEndpoint":"/videos","gatewayOverride":"kie","capabilities":{"audio":true,"reference":false,"frames":["first","last"],"durations":[4,6,8],"resolutions":["720p","1080p"],"aspect_ratios":["16:9","9:16"],"passthrough":[],"priceUsdPerUnit":0.159375}}'::jsonb),
  ('veo-3-1-lite', '{"id":"veo-3-1-lite","provider":"byteplus","family":"Veo","variant":"3.1 Lite","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":16,"unitKind":"second","expectedLatencyMsP50":90000,"expectedLatencyMsP95":180000,"maxDurationSeconds":8,"maxResolution":"1080p","providerModelId":"google/veo-3.1-lite","providerEndpoint":"/videos","gatewayOverride":"kie","capabilities":{"audio":true,"reference":false,"frames":["first","last"],"durations":[4,6,8],"resolutions":["720p","1080p"],"aspect_ratios":["16:9","9:16"],"passthrough":[],"priceUsdPerUnit":0.021875}}'::jsonb),
  ('grok-imagine-video', '{"id":"grok-imagine-video","provider":"byteplus","family":"Grok","variant":"Imagine","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":7,"unitKind":"second","expectedLatencyMsP50":90000,"expectedLatencyMsP95":180000,"maxDurationSeconds":6,"maxResolution":"720p","providerModelId":"x-ai/grok-imagine-video","providerEndpoint":"/videos","gatewayOverride":"kie","capabilities":{"audio":false,"reference":false,"frames":[],"durations":[6],"resolutions":["480p","720p"],"aspect_ratios":["16:9","9:16"],"passthrough":[],"priceUsdPerUnit":0.015}}'::jsonb),
  ('happyhorse-1-1', '{"id":"happyhorse-1-1","provider":"byteplus","family":"HappyHorse","variant":"1.1","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":55,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":240000,"maxDurationSeconds":10,"maxResolution":"1080p","providerModelId":"alibaba/happyhorse-1.1","fallbackGateway":"kie","providerEndpoint":"/videos","capabilities":{"audio":false,"reference":false,"frames":["first"],"durations":[4,6,8,10],"resolutions":["720p","1080p"],"aspect_ratios":["16:9","9:16","1:1"],"passthrough":[],"priceUsdPerUnit":0.1278}}'::jsonb),
  ('happyhorse-1-0', '{"id":"happyhorse-1-0","provider":"byteplus","family":"HappyHorse","variant":"1.0","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":73,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":240000,"maxDurationSeconds":10,"maxResolution":"1080p","providerModelId":"alibaba/happyhorse-1.0","providerEndpoint":"/videos","capabilities":{"audio":false,"reference":false,"frames":["first"],"durations":[4,6,8,10],"resolutions":["720p","1080p"],"aspect_ratios":["16:9","9:16","1:1"],"passthrough":[],"priceUsdPerUnit":0.1694}}'::jsonb),
  ('kling-v3-0-std', '{"id":"kling-v3-0-std","provider":"byteplus","family":"Kling","variant":"v3.0","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":54,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":240000,"maxDurationSeconds":10,"maxResolution":"720p","providerModelId":"kwaivgi/kling-v3.0-std","providerEndpoint":"/videos","capabilities":{"audio":true,"reference":false,"frames":["first","last"],"durations":[5,10],"resolutions":["720p"],"aspect_ratios":["16:9","9:16","1:1"],"passthrough":["cfg_scale"],"priceUsdPerUnit":0.126}}'::jsonb),
  ('wan-2-7', '{"id":"wan-2-7","provider":"byteplus","family":"Wan","variant":"2.7","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":51,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":240000,"maxDurationSeconds":10,"maxResolution":"1080p","providerModelId":"alibaba/wan-2.7","providerEndpoint":"/videos","gatewayOverride":"kie","fallbackGateway":"openrouter","capabilities":{"audio":true,"reference":false,"frames":["first","last"],"durations":[4,6,8,10],"resolutions":["720p","1080p"],"aspect_ratios":["16:9","9:16","1:1"],"passthrough":["prompt_extend"],"priceUsdPerUnit":0.12,"fallbackUsdPerUnit":0.15}}'::jsonb),
  ('flux-2-pro', '{"id":"flux-2-pro","provider":"byteplus","family":"FLUX","variant":"2 Pro","kind":"image","isActive":true,"tierMin":"creator","creditCostPerUnit":13,"unitKind":"image","expectedLatencyMsP50":5000,"expectedLatencyMsP95":12000,"maxResolution":"2048x2048","providerModelId":"black-forest-labs/flux.2-pro","providerEndpoint":"/images","capabilities":{"reference":true,"multi_image":true,"edit":true,"maxRefs":8,"resolutions":[],"aspect_ratios":[],"priceUsdPerUnit":0.03}}'::jsonb),
  ('recraft-v4', '{"id":"recraft-v4","provider":"byteplus","family":"Recraft","variant":"4","kind":"image","isActive":true,"tierMin":"start","creditCostPerUnit":18,"unitKind":"image","expectedLatencyMsP50":5000,"expectedLatencyMsP95":12000,"maxResolution":"1024x1024","providerModelId":"recraft/recraft-v4","providerEndpoint":"/images","capabilities":{"reference":true,"maxRefs":1,"resolutions":[],"aspect_ratios":[],"priceUsdPerUnit":0.04}}'::jsonb),
  ('recraft-v4-vector', '{"id":"recraft-v4-vector","provider":"byteplus","family":"Recraft","variant":"4 Vector","kind":"image","isActive":true,"tierMin":"creator","creditCostPerUnit":35,"unitKind":"image","expectedLatencyMsP50":5000,"expectedLatencyMsP95":12000,"maxResolution":"1024x1024","providerModelId":"recraft/recraft-v4-vector","providerEndpoint":"/images","capabilities":{"reference":true,"maxRefs":1,"resolutions":[],"aspect_ratios":[],"vector":true,"priceUsdPerUnit":0.08}}'::jsonb),
  ('gemini-2-5-flash-image', '{"id":"gemini-2-5-flash-image","provider":"byteplus","family":"Nano Banana","variant":"2.5 Flash","kind":"image","isActive":true,"tierMin":"start","creditCostPerUnit":9,"unitKind":"image","expectedLatencyMsP50":5000,"expectedLatencyMsP95":12000,"maxResolution":"1024x1024","providerModelId":"gemini-2.5-flash-image","providerEndpoint":"/v1/chat/completions","capabilities":{"reference":true,"multi_image":true,"edit":true,"maxRefs":3,"resolutions":[],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"forceGateway":"nanobanana","priceUsdPerUnit":0.02,"fallbackUsdPerUnit":0.02}}'::jsonb),
  ('gemini-3-pro-image', '{"id":"gemini-3-pro-image","provider":"byteplus","family":"Nano Banana","variant":"3 Pro","kind":"image","isActive":true,"tierMin":"creator","creditCostPerUnit":50,"unitKind":"image","expectedLatencyMsP50":20000,"expectedLatencyMsP95":45000,"maxResolution":"4096x4096","providerModelId":"gemini-3-pro-image","providerEndpoint":"/v1beta/models/gemini-3-pro-image:generateContent","capabilities":{"reference":true,"multi_image":true,"edit":true,"maxRefs":8,"resolutions":["1K","2K","4K"],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"forceGateway":"nanobanana","priceUsdPerUnit":0.09,"fallbackUsdPerUnit":0.12}}'::jsonb),
  ('gemini-3-1-flash-image', '{"id":"gemini-3-1-flash-image","provider":"byteplus","family":"Nano Banana","variant":"3.1 Flash","kind":"image","isActive":true,"tierMin":"start","creditCostPerUnit":32,"unitKind":"image","expectedLatencyMsP50":6000,"expectedLatencyMsP95":15000,"maxResolution":"4096x4096","providerModelId":"gemini-3.1-flash-image","providerEndpoint":"/v1/chat/completions","capabilities":{"reference":true,"multi_image":true,"edit":true,"maxRefs":3,"resolutions":["1K","2K","4K"],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"forceGateway":"nanobanana","priceUsdPerUnit":0.055,"fallbackUsdPerUnit":0.04}}'::jsonb),
  ('gemini-3-1-flash-lite-image', '{"id":"gemini-3-1-flash-lite-image","provider":"byteplus","family":"Nano Banana","variant":"3.1 Flash Lite","kind":"image","isActive":true,"tierMin":"free","creditCostPerUnit":11,"unitKind":"image","expectedLatencyMsP50":4000,"expectedLatencyMsP95":10000,"maxResolution":"1024x1024","providerModelId":"gemini-3.1-flash-lite-image","providerEndpoint":"/v1/chat/completions","capabilities":{"reference":true,"multi_image":true,"edit":true,"maxRefs":10,"resolutions":[],"aspect_ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"forceGateway":"nanobanana","priceUsdPerUnit":0.025,"fallbackUsdPerUnit":0.02}}'::jsonb),
  ('gpt-image-2', '{"id":"gpt-image-2","provider":"byteplus","family":"GPT Image","variant":"2","kind":"image","isActive":true,"tierMin":"start","creditCostPerUnit":33,"unitKind":"image","expectedLatencyMsP50":8000,"expectedLatencyMsP95":20000,"maxResolution":"1536x1024","providerModelId":"gpt-image-2","providerEndpoint":"/v1/images/generations","capabilities":{"reference":true,"multi_image":true,"maxRefs":8,"resolutions":["low","medium","high"],"aspect_ratios":[],"forceGateway":"nanobanana","priceUsdPerUnit":0.05,"fallbackUsdPerUnit":0.08}}'::jsonb),
  ('gemini-omni-flash', '{"id":"gemini-omni-flash","provider":"byteplus","family":"Gemini Omni","variant":"Flash","kind":"video","isActive":true,"tierMin":"start","creditCostPerUnit":35,"unitKind":"second","expectedLatencyMsP50":120000,"expectedLatencyMsP95":240000,"maxDurationSeconds":10,"maxResolution":"1080p","providerModelId":"gemini-omni-flash-text-to-video","providerEndpoint":"/videos","capabilities":{"forceGateway":"geminiomni","audio":true,"audioControl":false,"reference":true,"frames":["first"],"durations":[4,6,8,10],"resolutions":[],"aspect_ratios":["16:9","9:16"],"priceUsdPerUnit":0.079,"fallbackUsdPerUnit":0.112}}'::jsonb)
)
INSERT INTO "models" (
  "id", "provider", "family", "variant", "kind", "is_active", "tier_min",
  "credit_cost_per_unit", "unit_kind", "expected_latency_ms_p50",
  "expected_latency_ms_p95", "max_duration_seconds", "max_resolution",
  "provider_model_id", "provider_endpoint", "capabilities", "gateway_override",
  "fallback_gateway", "rights_moderation_provider"
)
SELECT
  id,
  (data->>'provider')::"provider",
  data->>'family',
  data->>'variant',
  (data->>'kind')::"model_kind",
  (data->>'isActive')::boolean,
  (data->>'tierMin')::"tier",
  (data->>'creditCostPerUnit')::integer,
  (data->>'unitKind')::"unit_kind",
  (data->>'expectedLatencyMsP50')::integer,
  (data->>'expectedLatencyMsP95')::integer,
  (data->>'maxDurationSeconds')::integer,
  data->>'maxResolution',
  data->>'providerModelId',
  data->>'providerEndpoint',
  data->'capabilities',
  data->>'gatewayOverride',
  data->>'fallbackGateway',
  COALESCE(data->>'rightsModerationProvider', 'internal')
FROM model_rows
-- Every affected existing model must converge to this migration's catalog row,
-- too. `DO NOTHING` made seed-only routing changes invisible in production.
-- Capabilities retain unrelated operator-era keys; all top-level catalog fields
-- (including fallback_gateway) come from the migration row.
ON CONFLICT ("id") DO UPDATE SET
  "provider" = EXCLUDED."provider",
  "family" = EXCLUDED."family",
  "variant" = EXCLUDED."variant",
  "kind" = EXCLUDED."kind",
  "is_active" = EXCLUDED."is_active",
  "tier_min" = EXCLUDED."tier_min",
  "credit_cost_per_unit" = EXCLUDED."credit_cost_per_unit",
  "unit_kind" = EXCLUDED."unit_kind",
  "expected_latency_ms_p50" = EXCLUDED."expected_latency_ms_p50",
  "expected_latency_ms_p95" = EXCLUDED."expected_latency_ms_p95",
  "max_duration_seconds" = EXCLUDED."max_duration_seconds",
  "max_resolution" = EXCLUDED."max_resolution",
  "provider_model_id" = EXCLUDED."provider_model_id",
  "provider_endpoint" = EXCLUDED."provider_endpoint",
  "capabilities" = "models"."capabilities" || EXCLUDED."capabilities",
  "gateway_override" = EXCLUDED."gateway_override",
  "fallback_gateway" = EXCLUDED."fallback_gateway",
  "rights_moderation_provider" = EXCLUDED."rights_moderation_provider";

WITH price_rows(
  id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, source_ref, is_active
) AS (
  VALUES
  ('pricing-v14-001', 'veo-3-1', '720p', false, false, 'second', 895, 8, 'Сетка FX!AA9/AB9', true),
  ('pricing-v14-002', 'veo-3-1', '1080p', false, false, 'second', 913, 8, 'Сетка FX!AA10/AB10', true),
  ('pricing-v14-003', 'veo-3-1-fast', '720p', false, false, 'second', 215, 8, 'Сетка FX!AA11/AB11', true),
  ('pricing-v14-004', 'veo-3-1-fast', '1080p', false, false, 'second', 233, 8, 'Сетка FX!AA12/AB12', true),
  ('pricing-v14-005', 'veo-3-1-lite', '720p', false, false, 'second', 108, 8, 'Сетка FX!AA13/AB13', true),
  ('pricing-v14-006', 'veo-3-1-lite', '1080p', false, false, 'second', 126, 8, 'Сетка FX!AA14/AB14', true),
  ('pricing-v14-007', 'seedance-2-0', '4K', false, false, 'second', 2183, 5, 'Сетка FX!AA15/AB15', false),
  ('pricing-v14-008', 'seedance-2-0', '1080p', false, false, 'second', 776, 5, 'Сетка FX!AA16/AB16', true),
  ('pricing-v14-009', 'seedance-2-0', '720p', false, false, 'second', 564, 5, 'Сетка FX!AA17/AB17', true),
  ('pricing-v14-010', 'seedance-2-0', '480p', false, false, 'second', 564, 5, 'Сетка FX!AA18/AB18', true),
  ('pricing-v14-011', 'seedance-2-0-fast', '720p', false, false, 'second', 259, 5, 'Сетка FX!AA19/AB19', true),
  ('pricing-v14-012', 'seedance-2-0-fast', '480p', false, false, 'second', 183, 5, 'Сетка FX!AA20/AB20', true),
  ('pricing-v14-013', 'happyhorse-1-1', '720p', false, false, 'second', 226, 5, 'Сетка FX!AA21/AB21', true),
  ('pricing-v14-014', 'happyhorse-1-1', '1080p', false, false, 'second', 274, 5, 'Сетка FX!AA22/AB22', true),
  ('pricing-v14-015', 'happyhorse-1-0', '720p', false, false, 'second', 284, 5, 'Сетка FX!AA23/AB23', true),
  ('pricing-v14-016', 'happyhorse-1-0', '1080p', false, false, 'second', 365, 5, 'Сетка FX!AA24/AB24', true),
  ('pricing-v14-017', 'wan-2-7', '720p', false, false, 'second', 251, 5, 'Сетка FX!AA25/AB25', true),
  ('pricing-v14-018', 'wan-2-7', '1080p', false, false, 'second', 251, 5, 'Сетка FX!AA26/AB26', true),
  ('pricing-v14-019', 'kling-v3-0-std', '720p', false, false, 'second', 270, 5, 'Сетка FX!AA27/AB27', true),
  ('pricing-v14-020', 'grok-imagine-video', '720p', false, false, 'second', 41, 6, 'Сетка FX!AA28/AB28', true),
  ('pricing-v14-021', 'grok-imagine-video', '480p', false, false, 'second', 41, 6, 'Сетка FX!AA29/AB29', true),
  ('pricing-v14-022', 'gemini-omni-flash', 'default', false, false, 'second', 273, 8, 'Сетка FX!AA30/AB30', true),
  ('pricing-v14-023', 'gemini-2-5-flash-image', 'default', false, false, 'image', 9, 1, 'Сетка FX!AA31', true),
  ('pricing-v14-024', 'gemini-3-1-flash-image', '1K', false, false, 'image', 23, 1, 'Сетка FX!AA32', true),
  ('pricing-v14-025', 'gemini-3-1-flash-image', '2K', false, false, 'image', 27, 1, 'Сетка FX!AA47', true),
  ('pricing-v14-026', 'gemini-3-1-flash-image', '4K', false, false, 'image', 32, 1, 'Сетка FX!AA48', true),
  ('pricing-v14-027', 'gemini-3-1-flash-lite-image', 'default', false, false, 'image', 11, 1, 'Сетка FX!AA33', true),
  ('pricing-v14-028', 'gemini-3-pro-image', '1K', false, false, 'image', 37, 1, 'Сетка FX!AA34', true),
  ('pricing-v14-029', 'gemini-3-pro-image', '2K', false, false, 'image', 43, 1, 'Сетка FX!AA46', true),
  ('pricing-v14-030', 'gemini-3-pro-image', '4K', false, false, 'image', 50, 1, 'Сетка FX!AA35', true),
  ('pricing-v14-031', 'gpt-image-2', 'low', false, false, 'image', 13, 1, 'Сетка FX!AA36', true),
  ('pricing-v14-032', 'gpt-image-2', 'medium', false, false, 'image', 21, 1, 'Сетка FX!AA37', true),
  ('pricing-v14-033', 'gpt-image-2', 'high', false, false, 'image', 33, 1, 'Сетка FX!AA38', true),
  ('pricing-v14-034', 'gpt-image-2', 'default', false, false, 'image', 27, 1, 'derived:gpt-image-2-default', false),
  ('pricing-v14-035', 'seedream-4-5', '1K', false, false, 'image', 14, 1, 'Сетка FX!AA39', false),
  ('pricing-v14-036', 'seedream-4-5', '2K', false, false, 'image', 17, 1, 'Сетка FX!AA49', true),
  ('pricing-v14-037', 'seedream-4-5', '4K', false, false, 'image', 20, 1, 'Сетка FX!AA50', true),
  ('pricing-v14-038', 'seedream-5-0-pro', '1K', false, false, 'image', 16, 1, 'Сетка FX!AA40', true),
  ('pricing-v14-039', 'seedream-5-0-pro', '2K', false, false, 'image', 29, 1, 'Сетка FX!AA41', true),
  ('pricing-v14-040', 'seedream-5-0-lite', '2K', false, false, 'image', 12, 1, 'Сетка FX!AA42', true),
  ('pricing-v14-041', 'seedream-5-0-lite', '3K', false, false, 'image', 14, 1, 'Сетка FX!AA51', true),
  ('pricing-v14-042', 'seedream-5-0-lite', '4K', false, false, 'image', 17, 1, 'Сетка FX!AA52', true),
  ('pricing-v14-043', 'flux-2-pro', 'default', false, false, 'image', 13, 1, 'Сетка FX!AA43', true),
  ('pricing-v14-044', 'recraft-v4', 'default', false, false, 'image', 18, 1, 'Сетка FX!AA44', true),
  ('pricing-v14-045', 'recraft-v4-vector', 'default', false, false, 'image', 35, 1, 'Сетка FX!AA45', true),
  ('pricing-v14-046', 'seedance-2-0-reference-to-video', '4K', true, false, 'second', 242, 1, 'Параметрика!C40', false),
  ('pricing-v14-047', 'seedance-2-0-reference-to-video', '1080p', true, false, 'second', 117, 1, 'Параметрика!C41', false),
  ('pricing-v14-048', 'seedance-2-0-reference-to-video', '720p', true, false, 'second', 47, 1, 'Параметрика!C42', false),
  ('pricing-v14-049', 'seedance-2-0-reference-to-video', '480p', true, false, 'second', 22, 1, 'Параметрика!C43', false),
  ('pricing-v14-050', 'seedance-2-0-fast-reference-to-video', '720p', true, false, 'second', 34, 1, 'Параметрика!C44', false),
  ('pricing-v14-051', 'seedance-2-0-fast-reference-to-video', '480p', true, false, 'second', 15, 1, 'Параметрика!C45', false),
  ('pricing-v14-052', 'seedance-2-0-reference-to-video', '1080p', false, false, 'second', 776, 5, 'Сетка FX!AA16/AB16 (deliberate mirror of the t2v twin — owner ruling 5)', true),
  ('pricing-v14-053', 'seedance-2-0-reference-to-video', '720p', false, false, 'second', 564, 5, 'Сетка FX!AA17/AB17 (deliberate mirror of the t2v twin — owner ruling 5)', true),
  ('pricing-v14-054', 'seedance-2-0-reference-to-video', '480p', false, false, 'second', 564, 5, 'Сетка FX!AA18/AB18 (deliberate mirror of the t2v twin — owner ruling 5)', true),
  ('pricing-v14-055', 'seedance-2-0-fast-reference-to-video', '720p', false, false, 'second', 259, 5, 'Сетка FX!AA19/AB19 (deliberate mirror of the t2v twin — owner ruling 5)', true),
  ('pricing-v14-056', 'seedance-2-0-fast-reference-to-video', '480p', false, false, 'second', 183, 5, 'Сетка FX!AA20/AB20 (deliberate mirror of the t2v twin — owner ruling 5)', true)
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
  "base_credits" = EXCLUDED."base_credits",
  "base_units" = EXCLUDED."base_units",
  "unit_kind" = EXCLUDED."unit_kind",
  "source_ref" = EXCLUDED."source_ref",
  "is_active" = EXCLUDED."is_active";

WITH eligible AS (
  SELECT j.id, j.credits_reserved, (w.params->>'n')::integer AS requested_n
  FROM jobs j
  JOIN workflows w ON w.id = j.workflow_id
  JOIN models m ON m.id = j.model_id
  WHERE m.kind = 'image'
    AND j.credit_unit_cost IS NULL
    AND j.credits_reserved > 0
    AND jsonb_typeof(w.params->'n') = 'number'
    AND (w.params->>'n') ~ '^[1-9][0-9]*$'
    AND (w.params->>'n')::numeric <= 2147483647
)
UPDATE jobs j
SET credit_unit_cost = e.credits_reserved / e.requested_n
FROM eligible e
WHERE j.id = e.id
  AND e.credits_reserved % e.requested_n = 0
  AND e.credits_reserved / e.requested_n > 0;

-- Never guess an ambiguous settlement rate. The notice provides the concrete
-- job ids that require manual reconciliation after this migration.
DO $$
DECLARE
  manual_job_ids text;
BEGIN
  SELECT string_agg(j.id, ', ' ORDER BY j.id)
  INTO manual_job_ids
  FROM jobs AS j
  JOIN models AS m ON m.id = j.model_id
  LEFT JOIN workflows AS w ON w.id = j.workflow_id
  WHERE m.kind = 'image'
    AND j.credit_unit_cost IS NULL
    AND j.credits_reserved > 0;

  IF manual_job_ids IS NOT NULL THEN
    RAISE NOTICE 'pricing-v14 manual settlement reconciliation required for jobs: %', manual_job_ids;
  END IF;
END $$;
