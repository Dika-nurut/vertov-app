-- GPT Image 2 offers these eight Board aspect ratios across three priced
-- quality tiers (low/medium/high — aspect does not move the price). Keep the live
-- catalogue aligned with the primary and Kie fallback contracts; exotic custom
-- dimensions remain intentionally unoffered.
UPDATE "models"
SET
  "max_resolution" = '3840x2160',
  "capabilities" = "capabilities" || '{"aspect_ratios":["21:9","16:9","3:2","4:3","1:1","3:4","2:3","9:16"]}'::jsonb
WHERE "id" = 'gpt-image-2';
