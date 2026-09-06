-- Which LEG of a failover chain actually served a job.
--
-- `gateway_used` was only ever written from the 2-leg circuit breaker's meta, so
-- a job served by an inner FallbackChainAdapter leg was stored under the chain's
-- own alias ('nanobanana' / 'geminiomni') with used_fallback = false. The admin
-- cost report then valued it at the model's PRIMARY priceUsdPerUnit — which is
-- how the openrouter-official 3rd leg, ~2.7x the primary, stayed invisible.
--
-- Additive + forward-only. `gateway_used` keeps its name and gains its honest
-- meaning (the LEAF gateway); the new column carries how many failover hops that
-- leg is from the primary, which is what prices it:
--   0 -> capabilities.priceUsdPerUnit
--   1 -> capabilities.fallbackUsdPerUnit
--  >=2 -> no cost is recorded anywhere today -> the report must say UNKNOWN
-- NULL means the depth is genuinely unknown, and the report must NOT substitute
-- the primary's rate for it.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "fallback_depth" integer;
--> statement-breakpoint

-- Backfill what history actually tells us, and nothing more:
--  * a chain alias in gateway_used = we never recorded which of its 2-3 legs
--    served -> leave NULL (unknown), do NOT assume the primary;
--  * used_fallback = the circuit breaker's single hop -> depth 1;
--  * everything else was a single-gateway or primary-leg job -> depth 0.
UPDATE "jobs"
SET "fallback_depth" = CASE
  WHEN "gateway_used" IN ('nanobanana', 'geminiomni') THEN NULL
  WHEN "used_fallback" THEN 1
  ELSE 0
END
WHERE "fallback_depth" IS NULL;
