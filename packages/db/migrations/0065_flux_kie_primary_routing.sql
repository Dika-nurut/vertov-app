-- FLUX.2 Pro: route to kie as PRIMARY with OpenRouter as the availability fallback.
--
-- Why this needs a migration and not just a reseed: `scripts/seed.ts` upserts these
-- two columns with COALESCE(existing, excluded), so an EXISTING row keeps whatever
-- routing it already has. flux-2-pro currently holds NULL/NULL in every deployed
-- database, and a reseed would leave it there — the seed change alone would take
-- effect on fresh deploys only.
--
-- Money: kie is $0.025/img at the 1K tier we sell against OpenRouter's $0.03 —
-- 41.6% vs 26.0% at the 13-credit price. The fallback keeps the thinner margin and
-- that is deliberate: the fallback floor is 0%, not 25% (ruling R-1), because
-- refusing to fail over converts a vendor outage into our own.
--
-- `fallback_usd_per_unit` is added in the same statement so the margin guardrail
-- scores the fallback leg instead of reporting flux as an uncosted gap.
UPDATE "models"
SET
  "gateway_override" = 'kie',
  "fallback_gateway" = 'openrouter',
  "capabilities" = "capabilities" || '{"priceUsdPerUnit":0.025,"fallbackUsdPerUnit":0.03}'::jsonb
WHERE "id" = 'flux-2-pro';

-- HappyHorse 1.1: record the kie fallback's USD cost, which was previously
-- uncitable. kie publishes this model in kie-credits (1080p 29/s, 720p 22.5/s); the
-- owner's 2026-08-03 pricing screen fixes the kie credit at $0.005, giving $0.145/s
-- at the 1080p reference config this row is scored against. Routing is unchanged —
-- this only closes a hole where a real fallback leg read as having no cost at all.
UPDATE "models"
SET "capabilities" = "capabilities" || '{"fallbackUsdPerUnit":0.145}'::jsonb
WHERE "id" = 'happyhorse-1-1';
