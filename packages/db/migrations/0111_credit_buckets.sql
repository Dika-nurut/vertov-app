-- W2-a — additive allocation subledger. Backfill is an explicit offline step,
-- never part of this migration.
CREATE TABLE "credit_buckets" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users_app"("id") ON DELETE CASCADE,
  "origin" text NOT NULL,
  "priority" smallint NOT NULL,
  "granted" integer NOT NULL,
  "reserved" integer DEFAULT 0 NOT NULL,
  "consumed" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone,
  "grant_key" text NOT NULL UNIQUE,
  "related_order_id" text,
  "related_subscription_id" text,
  "cycle_number" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_buckets_origin_check"
    CHECK ("origin" IN ('legacy', 'subscription', 'pack', 'welcome', 'bonus', 'admin', 'refund', 'clawback')),
  CONSTRAINT "credit_buckets_granted_check"
    CHECK ("granted" >= 0 OR "origin" IN ('clawback', 'legacy')),
  CONSTRAINT "credit_buckets_reserved_consumed_check"
    CHECK ("reserved" >= 0 AND "consumed" >= 0),
  CONSTRAINT "credit_buckets_capacity_check"
    CHECK ("origin" IN ('clawback', 'legacy') OR "granted" >= "reserved" + "consumed"),
  CONSTRAINT "credit_buckets_id_user_id_uniq" UNIQUE("id", "user_id")
);--> statement-breakpoint
CREATE INDEX "credit_buckets_spend_idx"
  ON "credit_buckets" ("user_id", "priority", "expires_at" ASC NULLS LAST, "created_at");--> statement-breakpoint

CREATE TABLE "credit_bucket_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "bucket_id" text NOT NULL,
  "user_id" text NOT NULL,
  "job_id" text,
  "kind" text NOT NULL,
  "amount" integer NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_bucket_allocations_kind_check"
    CHECK ("kind" IN ('reserve', 'commit', 'release', 'clawback')),
  CONSTRAINT "credit_bucket_allocations_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "credit_bucket_allocations_bucket_user_fkey"
    FOREIGN KEY ("bucket_id", "user_id")
    REFERENCES "credit_buckets"("id", "user_id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "credit_bucket_allocations_user_job_kind_idx"
  ON "credit_bucket_allocations" ("user_id", "job_id", "kind");--> statement-breakpoint

ALTER TABLE "credit_transactions"
  ADD COLUMN "bucket_id" text REFERENCES "credit_buckets"("id");
