-- The margin alarm reads the journal on a timer, bounded to its own 24h window. That
-- bound limits the result set but not the scan: the only index over `submitted_at` is
-- `(leg_identity, rung, submitted_at)`, whose leading columns a global time predicate
-- leaves unconstrained. The journal gains a row per provider submit and is never
-- pruned, so without this the hourly read grows with every job ever run.
CREATE INDEX IF NOT EXISTS "route_attempt_journal_submitted_idx"
  ON "route_attempt_journal" USING btree ("submitted_at");
