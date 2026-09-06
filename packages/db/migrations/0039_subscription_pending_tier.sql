-- 2026-07-17: scheduled downgrade. `pending_tier` holds a cheaper tier the user
-- chose to move to at the next renewal (applies at period end, no proration).
-- Additive / forward-only; IF NOT EXISTS keeps re-application safe.
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "pending_tier" "tier";
