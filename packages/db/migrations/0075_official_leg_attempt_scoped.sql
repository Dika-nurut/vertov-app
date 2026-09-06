-- The third leg's budget stops being JOB-scoped, because a job has many ATTEMPTS.
--
-- 0068 made the row a reservation taken before the provider call, keyed
-- UNIQUE(job_id), so a retry re-reserved onto the SAME row and its pending_rub
-- accumulated. Every one of the three verbs then operated on that shared sum:
--
--   * settle computed `cost_rub - pending_rub + invoiced`, so the LAST attempt's
--     usage.cost replaced the accumulated pending of ALL attempts -- attempt 1
--     billed with no usable asset + attempt 2 succeeding with its own invoice =
--     two real 25.6264 RUB charges settling as one;
--   * release subtracted the whole accumulated pending and marked the row
--     settled, so a 401 on attempt 2 erased attempt 1's real charge and the
--     terminal settle then no-opped on settled_at;
--   * and a fan-out invoice that priced only 1 of 4 images replaced a
--     102.5056 RUB reservation with 25.6264 RUB, then booked the revenue of all
--     four -- which can read as profit and free the whole cap.
--
-- One row per ATTEMPT removes the shared figure those three overwrote. Forward
-- only; every existing row survives as attempt 1 of its job.

-- 1-based ordinal of the submit within the job. Existing rows are, by
-- construction, the only attempt that was ever accounted for.
ALTER TABLE "official_leg_spend"
  ADD COLUMN IF NOT EXISTS "attempt_seq" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

-- Why the configured figure stood instead of an invoice: no_invoice |
-- partial_invoice | other_attempt_invoiced | reaper_unsettled. NULL when the row
-- was invoiced or released.
ALTER TABLE "official_leg_spend"
  ADD COLUMN IF NOT EXISTS "cost_note" text;
--> statement-breakpoint

-- The one contract step. UNIQUE(job_id) is what forced a retry onto a shared
-- row; a second attempt cannot be inserted while it stands. Safe to drop in the
-- same migration that adds its replacement: the table ships in this same
-- undeployed wave (0067/0068), and the only writer that depended on it was the
-- ON CONFLICT (job_id) upsert being removed here -- an older worker meeting the
-- new schema errors on reserve, which fails the leg CLOSED (the chain degrades
-- to its two relays) rather than spending unmetered.
ALTER TABLE "official_leg_spend"
  DROP CONSTRAINT IF EXISTS "official_leg_spend_job_id_unique";
--> statement-breakpoint

ALTER TABLE "official_leg_spend"
  ADD CONSTRAINT "official_leg_spend_job_attempt_unique" UNIQUE("job_id", "attempt_seq");
--> statement-breakpoint

-- settle/release/the reaper sweep all find rows by job_id, which the dropped
-- UNIQUE used to index.
CREATE INDEX IF NOT EXISTS "official_leg_spend_job_id_idx"
  ON "official_leg_spend" ("job_id");
