-- Approved /pricing (owner 2026-09-25): Старт/Плюс sell «Seedance — Fast», Про and
-- above sell «Seedance — все модели». The catalogue still carried the retired
-- «Креатор» gate on full Seedance 2.0, which opened it at Плюс. Guarded on the old
-- value so an operator's manual pin in /admin/models survives.
UPDATE "models"
SET "tier_min" = 'pro'
WHERE "id" = 'seedance-2-0' AND "tier_min" = 'creator';
--> statement-breakpoint
UPDATE "models"
SET "tier_min" = 'pro'
WHERE "id" = 'seedance-2-0-reference-to-video' AND "tier_min" = 'creator';
