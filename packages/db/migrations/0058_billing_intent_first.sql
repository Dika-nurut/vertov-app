-- W1-0 — intent-first checkout.
--
-- Forward-only and additive: a new nullable column plus a PARTIAL unique index
-- whose predicate is false for every existing row (intent_key defaults NULL),
-- so the index is empty at deploy and cannot block or fail on live data. The
-- `orders` table is empty in production (canon §0); the plain (non-CONCURRENT)
-- index build is therefore instantaneous.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "intent_key" text;--> statement-breakpoint
-- At most ONE in-progress buying intent per user per subject. This is what
-- prevents the duplicate payment, and it is a database constraint rather than a
-- lock — nothing is held across the PSP's HTTP call.
CREATE UNIQUE INDEX IF NOT EXISTS "orders_live_intent_uniq"
  ON "orders" ("user_id", "intent_key")
  WHERE "our_status" = 'pending' AND "intent_key" IS NOT NULL;--> statement-breakpoint
-- Webhook events we could not attribute to a local order. Retained for retry +
-- reconciliation instead of being answered 200 and discarded.
CREATE TABLE IF NOT EXISTS "billing_unresolved_events" (
  "id" text PRIMARY KEY NOT NULL,
  "event" text NOT NULL,
  "object_id" text NOT NULL,
  "psp_payment_id" text,
  "order_ref" text,
  "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_unresolved_events_uniq"
  ON "billing_unresolved_events" ("event", "object_id");
