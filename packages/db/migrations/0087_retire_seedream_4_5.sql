-- The owner retired Seedream 4.5 because only the Seedream 5.0 family ships. Retire
-- the catalogue row rather than deleting it: existing jobs and history still reference
-- this id, and forward-only migrations preserve those references.
UPDATE "models"
SET "is_active" = false
WHERE "id" = 'seedream-4-5';
