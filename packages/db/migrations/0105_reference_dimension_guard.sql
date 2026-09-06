-- O-6: keep the common-denominator reference pixel ceiling in the live model
-- rows. The API checks this before pricing/reservation; the seed carries the
-- same value for fresh databases and this forward-only migration updates rows
-- that already exist in production without touching any operator routing pins.
UPDATE "models"
SET "capabilities" = COALESCE("capabilities", '{}'::jsonb)
  || '{"referenceMaxDimension":6000}'::jsonb
WHERE "id" = 'seedance-2-0-reference-to-video';

UPDATE "models"
SET "capabilities" = COALESCE("capabilities", '{}'::jsonb)
  || '{"referenceMaxDimension":6000}'::jsonb
WHERE "id" = 'seedance-2-0-fast-reference-to-video';
