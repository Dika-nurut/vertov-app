-- The price key gains a MODE and a REFERENCE BAND.
--
-- Finance rev. 10 prices two dimensions the four-column key (model, resolution,
-- video_input, audio) cannot express:
--
--   * mode — on some models an image-to-video shot costs more than the same clip
--     from text. Not because the vendor meters the frame: the per-second rate is
--     identical. The cheap gateway will not serve i2v, so it runs on the dearer
--     leg alone and the credits restore the margin there. A mode-blind key
--     charges the text-to-video price for both.
--   * reference band — a job carrying 2+ input images is its own configuration,
--     priced FLAT for the whole band at the band's worst count.
--
-- Additive and forward-only. Every existing row takes mode='any', refs_min=0,
-- refs_max=NULL, which means «matches any request» — so this migration changes
-- no price by itself. The rows that DO change a price come after it.
--
-- `mode` is text + CHECK rather than a Postgres enum: an enum value cannot be
-- USED in the transaction that adds it, and Drizzle applies every pending
-- migration in one transaction, so an enum here cannot bootstrap a fresh
-- database (the same trap `flat_rate` documents). The CHECK still refuses a typo,
-- which matters because a misspelled mode is an active row nothing can select.

ALTER TABLE "model_price_points" ADD COLUMN "mode" text NOT NULL DEFAULT 'any';
ALTER TABLE "model_price_points" ADD COLUMN "refs_min" integer NOT NULL DEFAULT 0;
ALTER TABLE "model_price_points" ADD COLUMN "refs_max" integer;

ALTER TABLE "model_price_points"
  ADD CONSTRAINT "model_price_points_refs_min_nonneg" CHECK ("refs_min" >= 0);
ALTER TABLE "model_price_points"
  ADD CONSTRAINT "model_price_points_refs_band_sane"
  CHECK ("refs_max" IS NULL OR "refs_max" >= "refs_min");
ALTER TABLE "model_price_points"
  ADD CONSTRAINT "model_price_points_mode_known"
  CHECK ("mode" IN ('any','t2v','i2v','r2v','video-edit','t2i','i2i'));

-- Widen the configuration identity. Safe by construction: the OLD constraint
-- guarantees no two existing rows share the first four columns, and every one of
-- them now carries the same ('any', 0) suffix, so none can collide.
ALTER TABLE "model_price_points" DROP CONSTRAINT "model_price_points_config_uq";
ALTER TABLE "model_price_points"
  ADD CONSTRAINT "model_price_points_config_uq"
  UNIQUE ("model_id", "resolution", "video_input", "audio", "mode", "refs_min");
