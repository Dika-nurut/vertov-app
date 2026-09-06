-- The third leg's budget stops being a successful-job counter.
--
-- 0067 inserted an official_leg_spend row only after uploads succeeded and the
-- guarded running->succeeded update claimed the job. Every other outcome spends
-- real provider money and wrote NOTHING: a call that returns no usable asset, a
-- multi-image fan-out failing after its siblings were billed, a watermark or
-- upload crash after generation, the reaper winning the settle race, any
-- terminal failure that refunds the customer.
--
-- And the pre-submit test read a historical sum with no reservation, so during
-- the outage this leg exists for, N concurrent jobs all saw the same headroom
-- and all submitted -- overshoot bounded by concurrency, not by the cap.
--
-- The row therefore becomes a RESERVATION taken BEFORE the provider call, which
-- later settles or releases. Additive + forward-only.

-- The part of cost_rub still in flight: reserved at the configured rate, real
-- outcome not yet known. Settling swaps it for the invoiced figure; releasing
-- subtracts it. Both rolling windows keep summing cost_rub - revenue_rub, so a
-- reservation counts against the cap from the moment it is taken.
ALTER TABLE "official_leg_spend"
  ADD COLUMN IF NOT EXISTS "pending_rub" numeric(14, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint

-- reserved | invoiced | configured | released -- see schema/official-leg-spend.ts.
ALTER TABLE "official_leg_spend"
  ADD COLUMN IF NOT EXISTS "cost_source" text DEFAULT 'reserved' NOT NULL;
--> statement-breakpoint

-- NULL = still in flight. Also the idempotency guard on settle/release.
ALTER TABLE "official_leg_spend"
  ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone;
--> statement-breakpoint

-- Backfill: every row 0067's settle-only counter wrote is already final, and
-- was priced at the configured per-rung rate. Without this they would read as
-- in-flight reservations forever and the new column default ('reserved') would
-- be a lie on historical data.
UPDATE "official_leg_spend"
SET "cost_source" = 'configured', "settled_at" = "occurred_at"
WHERE "settled_at" IS NULL;
