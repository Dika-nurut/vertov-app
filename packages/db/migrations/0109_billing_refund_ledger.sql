-- Durable refund state. A refund request may remain pending at Tochka for
-- days; only a provider-confirmed row is allowed to mutate credits/access.
DO $$ BEGIN
  CREATE TYPE "public"."refund_status" AS ENUM ('pending', 'confirmed', 'applied', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

ALTER TYPE "public"."order_our_status"
  ADD VALUE IF NOT EXISTS 'partially_refunded' BEFORE 'refunded';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "billing_refunds" (
  "id" text PRIMARY KEY NOT NULL,
  "psp" text NOT NULL,
  "order_id" text NOT NULL,
  "psp_payment_id" text NOT NULL,
  "refund_uid" text NOT NULL,
  "provider_refund_id" text,
  "amount_rub" numeric(10, 2) NOT NULL CHECK ("amount_rub" > 0),
  "status" "refund_status" DEFAULT 'pending' NOT NULL,
  "provider_status" text,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "confirmed_at" timestamptz,
  "applied_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "billing_refunds_psp_uid_uniq"
  ON "billing_refunds" ("psp", "refund_uid");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "billing_refunds_provider_id_uniq"
  ON "billing_refunds" ("psp", "provider_refund_id")
  WHERE "provider_refund_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "billing_refunds_payment_idx"
  ON "billing_refunds" ("psp", "psp_payment_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "billing_refunds_order_idx"
  ON "billing_refunds" ("order_id", "status");
