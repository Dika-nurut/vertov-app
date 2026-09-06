-- 2026-07-17: expand the `tier` enum for the 5-tier pricing grid.
-- Additive / forward-only — legacy values (`free`, `start`, `creator`, `studio`)
-- are untouched. `IF NOT EXISTS` keeps re-application safe on hand-managed DBs.
-- New catalog rows are seeded separately (packages/db/seed/subscription-catalog.ts),
-- never in this transaction (Postgres forbids using a freshly added enum value in
-- the same transaction that adds it).
ALTER TYPE "public"."tier" ADD VALUE IF NOT EXISTS 'plus';--> statement-breakpoint
ALTER TYPE "public"."tier" ADD VALUE IF NOT EXISTS 'pro';--> statement-breakpoint
ALTER TYPE "public"."tier" ADD VALUE IF NOT EXISTS 'max';
