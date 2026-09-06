-- W4.Wed: onboarding tracking — adds onboarded_at + onboarding_answers to users_app.
-- Both columns are nullable; NULL onboarded_at means the onboarding card should be shown.
-- onboarding_answers is NOT PII (no identifiers) — stored in users_app, not users_pii.
-- The deletion flow already cascades users_app rows, so 152-ФЗ compliance is preserved.
ALTER TABLE "users_app"
  ADD COLUMN IF NOT EXISTS "onboarded_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "onboarding_answers" jsonb;
