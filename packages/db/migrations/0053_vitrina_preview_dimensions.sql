ALTER TABLE "preset_packs" ADD COLUMN "preview_width" integer;--> statement-breakpoint
ALTER TABLE "preset_packs" ADD COLUMN "preview_height" integer;--> statement-breakpoint
-- Backfill the Витрина wall here rather than leaving it to the seed. Production
-- deploys run `db:migrate` only (scripts/deploy.sh:76) — `db:seed` is a CI-only
-- step (.github/workflows/ci.yml:114) — so without this the columns ship NULL,
-- every card is skipped for lacking dimensions, and the section self-hides
-- until someone reseeds by hand. Values are the posters' real intrinsic pixel
-- sizes, measured in a browser against production; they mirror
-- packages/db/seed/preset-packs.ts.
UPDATE "preset_packs" AS p
SET "preview_width" = d.w, "preview_height" = d.h
FROM (VALUES
  ('demo-veo-3-1-lite-jumbotron', 1400, 788),
  ('demo-gemini-3-1-flash-image-yearbook-90s', 1045, 1400),
  ('demo-wan-2-7-drone-pullback-kie', 1400, 788),
  ('samovar-still-life', 1400, 1400),
  ('demo-seedance-2-0-food-jutsu-1080p', 1400, 788),
  ('demo-seedream-5-0-pro-flag-banner', 778, 1400),
  ('demo-happyhorse-1-1-inflate', 1400, 788),
  ('piter-roof-sunset', 1400, 1400),
  ('demo-gemini-omni-golden-hour-car', 1400, 788),
  ('demo-seedream-4-0-figurine', 1050, 1400),
  ('demo-grok-imagine-video-paper-boat-extend', 752, 416),
  ('horror-poster-90s', 1400, 1400),
  ('demo-wan-2-7-golden-hour-recolor', 1400, 788),
  ('demo-gpt-image-2-film-poster', 1400, 933),
  ('demo-gemini-omni-flash-jumbotron', 1400, 788),
  ('demo-gemini-3-pro-image-pet-profession', 1045, 1400),
  ('demo-wan-2-7-mountain-pullback-atlas', 1280, 720),
  ('anime-portrait', 1400, 1400),
  ('demo-veo-3-1-fast-dolly-zoom-1080p', 1400, 788),
  ('demo-seedream-5-lite-bubbles-editorial', 1050, 1400),
  ('demo-wan-2-7-reference-to-video', 1280, 720),
  ('ps1-game-screenshot', 1400, 1400),
  ('explosion-behind', 960, 960),
  ('neon-rain', 960, 960)
) AS d(slug, w, h)
WHERE p."slug" = d.slug;