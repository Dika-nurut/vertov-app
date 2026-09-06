-- One durable anonymous Scenario acquisition claim per anti-farm cluster.
-- Failed/aborted rows are intentionally excluded so a provider failure can be
-- retried; completed and in-progress rows protect the one-call budget.
ALTER TABLE "script_assist_requests"
  ADD COLUMN IF NOT EXISTS "free_cluster_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "script_assist_requests_free_cluster_uidx"
  ON "script_assist_requests" USING btree ("free_cluster_key")
  WHERE "op" = 'structurize_free'
    AND "free_cluster_key" IS NOT NULL
    AND "status" NOT IN ('failed', 'aborted');
