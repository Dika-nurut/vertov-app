-- Preview dimensions for the two Витрина showcase rows added in the same change.
-- Same reason 0053 backfilled rather than leaving it to the seed: production
-- deploys run `db:migrate` only (scripts/deploy.sh:76) — `db:seed` is CI-only —
-- so a card whose dimensions arrive NULL is skipped by the wall entirely.
--
-- The rows themselves are inserted by the seed. This UPDATE is a no-op until
-- then, and idempotent after; it exists so a reseeded or hand-inserted row can
-- never end up dimensionless on prod.
UPDATE "preset_packs" AS p
SET "preview_width" = d.w, "preview_height" = d.h
FROM (VALUES
  ('demo-seedance-2-0-fast-explosion-behind', 960, 960),
  ('demo-seedance-2-0-fast-neon-rain', 960, 960)
) AS d(slug, w, h)
WHERE p."slug" = d.slug;
