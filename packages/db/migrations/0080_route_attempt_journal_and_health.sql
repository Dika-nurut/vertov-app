-- Phase 3a route attempts are a sibling ledger, not extra official_leg_spend rows.
-- official_leg_spend has gateway-less cap queries and old workers will continue
-- running them during a rolling deploy; generic rows there would cross-settle
-- vendor invoices and corrupt the finance cap.
CREATE TABLE "route_attempt_journal" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL,
  "attempt_seq" integer DEFAULT 1 NOT NULL,
  "model_id" text NOT NULL,
  "rung" text DEFAULT 'unknown' NOT NULL,
  "role" text DEFAULT 'primary' NOT NULL,
  "leg_identity" text NOT NULL,
  "gateway" text NOT NULL,
  "outcome" text DEFAULT 'intent' NOT NULL,
  "ambiguous" boolean DEFAULT false NOT NULL,
  "provider_job_id" text,
  "units" numeric(14, 4),
  "configured_expected_cost_rub" numeric(14, 4),
  "vendor_reported_cost_rub" numeric(14, 4),
  "revenue_rub" numeric(14, 4),
  "cost_source" text DEFAULT 'configured' NOT NULL,
  "cost_note" text,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "route_attempt_journal_role_check" CHECK ("role" IN ('primary', 'fallback')),
  CONSTRAINT "route_attempt_journal_outcome_check" CHECK (
    "outcome" IN ('intent', 'accepted', 'succeeded', 'failed', 'definitive_rejection', 'ambiguous')
  ),
  CONSTRAINT "route_attempt_journal_cost_source_check" CHECK (
    "cost_source" IN ('reserved', 'invoiced', 'configured', 'released')
  ),
  CONSTRAINT "route_attempt_journal_job_attempt_unique" UNIQUE ("job_id", "attempt_seq")
);
CREATE INDEX "route_attempt_journal_job_idx" ON "route_attempt_journal" USING btree ("job_id");
CREATE INDEX "route_attempt_journal_job_provider_idx"
  ON "route_attempt_journal" USING btree ("job_id", "provider_job_id");
CREATE INDEX "route_attempt_journal_leg_rung_submitted_idx"
  ON "route_attempt_journal" USING btree ("leg_identity", "rung", "submitted_at");

CREATE TABLE "route_leg_health" (
  "leg_identity" text PRIMARY KEY NOT NULL,
  "consecutive_submit_failures" integer DEFAULT 0 NOT NULL,
  "last_submit_failure_at" timestamp with time zone,
  "last_submit_success_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
