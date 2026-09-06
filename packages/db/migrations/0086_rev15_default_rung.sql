-- Finance's rev. 15 export now signs each model's default rung. This migration is
-- needed in addition to the seed because scripts/seed.ts does not rewrite an existing
-- row's capability bag, so a seed-only edit would land on fresh deploys only.
UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"1K"}'::jsonb
WHERE "id" = 'flux-2-pro';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"1K"}'::jsonb
WHERE "id" = 'gemini-3-1-flash-image';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"1K"}'::jsonb
WHERE "id" = 'gemini-3-pro-image';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"low"}'::jsonb
WHERE "id" = 'gpt-image-2';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"480p"}'::jsonb
WHERE "id" = 'grok-imagine-video';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"2K"}'::jsonb
WHERE "id" = 'seedream-5-0-lite';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"1K"}'::jsonb
WHERE "id" = 'seedream-5-0-pro';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"1080p"}'::jsonb
WHERE "id" = 'veo-3-1';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"720p"}'::jsonb
WHERE "id" = 'veo-3-1-fast';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"720p"}'::jsonb
WHERE "id" = 'veo-3-1-lite';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"720p"}'::jsonb
WHERE "id" = 'wan-2-7';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"720p"}'::jsonb
WHERE "id" = 'kling-v3-0-std';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"720p"}'::jsonb
WHERE "id" = 'happyhorse-1-0';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"720p"}'::jsonb
WHERE "id" = 'happyhorse-1-1';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"480p"}'::jsonb
WHERE "id" = 'seedance-2-0';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"default_resolution":"480p"}'::jsonb
WHERE "id" = 'seedance-2-0-fast';
