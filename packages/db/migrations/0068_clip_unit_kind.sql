-- Flat-rate prices: one charge for the whole job, whatever the duration.
--
-- Veo is sold this way because that is how the vendor bills it — one price per clip at
-- 4, 6 or 8 seconds. Our kernel prorates by seconds, so a 4-second Veo was billing
-- roughly half of a cost we pay in full.
--
-- WHY A COLUMN AND NOT A `clip` VALUE ON `unit_kind`, which is the obvious shape and was
-- the first attempt: Postgres refuses to USE a new enum value inside the transaction
-- that added it, and Drizzle applies every pending migration in ONE transaction. Adding
-- the value in its own FILE is not enough — the file boundary is not a transaction
-- boundary. A fresh database could therefore never be migrated from zero: CI and every
-- new environment would fail on first `db:migrate`, which is where this was caught.
--
-- It is also the better model. Flatness is a property of the TARIFF, not of the unit:
-- Veo is still sold to the customer in seconds, it simply does not cost more to make
-- the clip longer. `unit_kind` keeps meaning "what a unit is"; `flat_rate` says whether
-- the count of them moves the price.
ALTER TABLE "model_price_points" ADD COLUMN IF NOT EXISTS "flat_rate" boolean NOT NULL DEFAULT false;

-- A flat row is priced for the whole job, so a base_units other than 1 would be a
-- number nothing reads — and a reader who did read it would prorate.
ALTER TABLE "model_price_points" DROP CONSTRAINT IF EXISTS "model_price_points_flat_rate_base_units";
ALTER TABLE "model_price_points" ADD CONSTRAINT "model_price_points_flat_rate_base_units"
  CHECK ("flat_rate" = false OR "base_units" = 1);
