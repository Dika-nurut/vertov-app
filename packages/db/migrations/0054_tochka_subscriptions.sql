-- Store the bank-side recurring operation and consumer identifiers separately
-- from our subscription state. These values are required for future Charge
-- Subscription calls and are intentionally nullable for legacy/YooKassa rows.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "psp_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "psp_consumer_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_psp_subscription_id_idx"
  ON "subscriptions" ("psp_subscription_id");
