-- The third leg of the image chain gets a price, a budget, and an off switch.
--
-- `nanobanana` is laozhang -> kie -> Google's own listing on OpenRouter. That
-- third leg armed itself from a HARDCODED slug map (no model row opted in) and
-- had never been costed: at the one invoice figure we hold, gemini-3-pro-image
-- at 4K sells there at -54.8% margin.
--
-- Finance ruled 2026-08-02 (docs/business/finance-ask-model-cogs-2026-08-02.md
-- Ask 8, option b): keep the leg as ban-wave insurance, inside a cap on
-- accumulated negative margin -- 3 000 RUB/day, 20 000 RUB/rolling month --
-- and log every ruble. Additive + forward-only.

-- 1. The counter. One row per job the third leg served. Both sides of the
--    margin are stored raw so "log every ruble" is literal and the caps can be
--    re-derived if the rule changes. UNIQUE(job_id) because a settle can be
--    retried and a double-count would spend the budget twice for one job.
CREATE TABLE IF NOT EXISTS "official_leg_spend" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL,
  "model_id" text NOT NULL,
  "rung" text NOT NULL,
  "units" integer NOT NULL,
  "cost_rub" numeric(14, 4) NOT NULL,
  "revenue_rub" numeric(14, 4) NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "official_leg_spend_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint

-- Both budget windows roll (trailing 24 h / 30 d), so every read is a range
-- scan on occurred_at.
CREATE INDEX IF NOT EXISTS "official_leg_spend_occurred_at_idx"
  ON "official_leg_spend" ("occurred_at");
--> statement-breakpoint

-- 2. The caps, as DATA. Finance retunes these with an UPDATE, not a deploy.
--    A missing row reads as 0 in code, which turns the leg OFF -- "no config"
--    must never mean "no limit", which was the defect being closed here.
INSERT INTO "app_settings" ("key", "value", "updated_by")
VALUES
  ('official_leg_budget_daily_rub', '3000'::jsonb, NULL),
  ('official_leg_budget_monthly_rub', '20000'::jsonb, NULL)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

-- 3. Opt the four Gemini image rows into the leg EXPLICITLY. Until now the
--    adapter inferred them from a hardcoded map; `openrouterFallbackSlug` is
--    now the only opt-in, so a row that does not carry one cannot be served
--    there at all.
UPDATE "models" SET "capabilities" = "capabilities" ||
  '{"openrouterFallbackSlug":"google/gemini-2.5-flash-image"}'::jsonb
WHERE "id" = 'gemini-2-5-flash-image';
--> statement-breakpoint

UPDATE "models" SET "capabilities" = "capabilities" ||
  '{"openrouterFallbackSlug":"google/gemini-3.1-flash-image"}'::jsonb
WHERE "id" = 'gemini-3-1-flash-image';
--> statement-breakpoint

UPDATE "models" SET "capabilities" = "capabilities" ||
  '{"openrouterFallbackSlug":"google/gemini-3.1-flash-lite-image"}'::jsonb
WHERE "id" = 'gemini-3-1-flash-lite-image';
--> statement-breakpoint

-- 4. gemini-3-pro-image additionally carries the ONE third-leg rate we have a
--    real OpenRouter invoice for: $0.241344 for a 4K generation. The rate is a
--    per-RUNG map, unlike the scalar priceUsdPerUnit/fallbackUsdPerUnit of legs
--    0 and 1, because OpenRouter passes Google's resolution-tiered list price
--    straight through. Its 1K/2K rungs and all three other rows stay uncosted,
--    and an uncosted rung is REFUSED on this leg -- a leg we cannot price is a
--    leg we cannot charge against the cap.
UPDATE "models" SET "capabilities" = "capabilities" ||
  '{"openrouterFallbackSlug":"google/gemini-3-pro-image","officialUsdPerUnit":{"4K":0.241344}}'::jsonb
WHERE "id" = 'gemini-3-pro-image';
