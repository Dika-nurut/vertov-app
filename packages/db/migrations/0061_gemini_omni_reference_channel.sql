-- Gemini Omni has one generic plural image_urls channel, not a positional frame.
-- Keep the image cap absent: kie documents multiple files but no maximum.
UPDATE "models"
SET "capabilities" =
  ("capabilities" - 'frames') ||
  '{"reference":true,"maxVideoRefs":0,"maxAudioRefs":0}'::jsonb
WHERE "id" = 'gemini-omni-flash';
