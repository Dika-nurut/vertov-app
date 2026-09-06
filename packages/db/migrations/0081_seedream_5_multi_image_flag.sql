-- Seedream 5.0 Pro / Lite: record the `multi_image` flag their own `maxRefs: 10`
-- already implies. Both rows shipped with `reference:true` + `maxRefs:10` but no
-- `multi_image`, an internal inconsistency in the capability bag rather than a
-- deliberate narrowing — kie's `seedream/5-{pro,lite}-image-to-image` slugs take an
-- `image_urls` ARRAY, so the models are multi-reference by construction.
--
-- Behaviourally INERT: every consumer reads `multi_image` only as the fallback for
-- an absent `maxRefs` (packages/shared/src/board-contract.ts) or OR-ed with
-- `reference` (apps/web/app/generate/GenerateClient.tsx), and both rows carry a
-- concrete `maxRefs` and `reference:true` already. Nothing about the reference slot
-- count, the price, or the routed leg changes.
--
-- It needs a migration and not just a reseed because `scripts/seed.ts` does not
-- rewrite an existing row's capability bag, so a seed-only edit would land on fresh
-- deploys only — and the route-contract parity guard (packages/shared
-- model-contract.test.ts) now derives `multi_image:true` from the kie route
-- contracts added for these two models, so prod and seed must agree.
--
-- Written as one statement per row (not an IN list) to match the house shape the
-- parity replayer in __tests__/pricing-catalogue-migration-parity.test.ts reads.
UPDATE "models"
SET "capabilities" = "capabilities" || '{"multi_image":true}'::jsonb
WHERE "id" = 'seedream-5-0-pro';

UPDATE "models"
SET "capabilities" = "capabilities" || '{"multi_image":true}'::jsonb
WHERE "id" = 'seedream-5-0-lite';
