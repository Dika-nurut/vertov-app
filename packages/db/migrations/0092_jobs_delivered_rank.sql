-- Finance rev. 20 §2: "Record the measured rank on the job. That single field turns the
-- 4% 4K weight in our consumption mix from a hypothesis into a measurement."
--
-- Three columns: the evidence, the verdict, and what was sold.
--   delivered_pixels       — the delivered frame's AREA (width*height), as measured. On a
--                            multi-asset job it is the WORST asset's area, because that
--                            is the one a refund would have to answer for.
--   delivered_rank_status  — 'ok' | 'downgraded' | 'unknown' from `judgeDeliveredRank`.
--   delivered_rank_sold    — the rung as SOLD, frozen at settle time. Not derivable
--                            later: a model's declared ladder can be edited between a
--                            job's enqueue and its run, and the weekly under-delivery
--                            rate has to group by what the customer actually bought.
--
-- `delivered_pixels` is written whenever the asset could be measured, INDEPENDENTLY of
-- the verdict. The image ladder's per-vendor pixel budgets are unknown today only because
-- nothing has ever measured them; a verdict-gated write would keep them unknown forever.
--
-- Why area and not width/height: the paid kie probe of 2026-08-11 asked for 720p on a
-- frame-conditioned Wan job and got 1108x830 — the input frame's aspect at 0,2% off the
-- nominal 720p pixel count. Storing dimensions invites the dimension comparison that
-- would have called that a downgrade and refunded every correct i2v job we run.
--
-- 'unknown' is a first-class outcome, not a gap: a quality-tier rung (low/medium/high is
-- not a size) and an unreadable asset both land there, and neither may ever trigger a
-- refund. All three columns are nullable and additive — existing rows read as "never
-- measured", which is exactly true.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "delivered_pixels" integer;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "delivered_rank_status" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "delivered_rank_sold" text;

-- The rolling-week withdrawal trigger (>5% downgrade on a rung takes it off sale) scans
-- recent jobs by verdict. Partial: only the non-null rows are ever read, and they are a
-- small minority of the table.
CREATE INDEX IF NOT EXISTS "jobs_delivered_rank_status_idx"
  ON "jobs" ("delivered_rank_status", "finished_at")
  WHERE "delivered_rank_status" IS NOT NULL;
