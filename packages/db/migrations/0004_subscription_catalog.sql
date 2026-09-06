-- W3.Tue: subscription engine schema.
-- 1) new `subscriptions_catalog` table — one row per priced tier.
-- 2) extend `subscriptions` with cycle_number + price snapshot + credits snapshot
--    so the cycle worker can produce deterministic idempotency keys
--    `sub:${id}:cycle:${cycleNumber}` and prorated upgrades have a stable
--    "old price" to subtract from even if the catalog row mutates later.
-- 3) extend `orders` with `metadata` jsonb — subscription orders carry
--    {purpose:'subscribe'|'upgrade'|'renewal', ...} so the webhook
--    apply path knows what to do without joining a side table.

CREATE TABLE IF NOT EXISTS "subscriptions_catalog" (
	"tier" "tier" PRIMARY KEY NOT NULL,
	"price_rub" integer NOT NULL,
	"credits_per_cycle" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "subscriptions"
	ADD COLUMN IF NOT EXISTS "cycle_number" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscriptions"
	ADD COLUMN IF NOT EXISTS "price_rub" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscriptions"
	ADD COLUMN IF NOT EXISTS "credits_per_cycle" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "orders"
	ADD COLUMN IF NOT EXISTS "metadata" jsonb;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "subscriptions_period_end_idx"
	ON "subscriptions" ("current_period_end")
	WHERE "status" = 'active';
