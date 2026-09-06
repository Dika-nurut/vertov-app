-- Repair generated stills that were stored with their parent video job's kind.
-- The predicate also covers rows created between this migration's authoring and deploy.
UPDATE "gallery_items"
SET "kind" = 'image'
WHERE "kind" = 'video'
  AND "asset_url" ~* '\.(jpe?g|png|webp)(?:[?#].*)?$';
