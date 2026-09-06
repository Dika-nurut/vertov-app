-- First-touch marketing attribution. One row per user, written once at signup.
-- All fields nullable text: we store only what the visitor actually carried.
CREATE TABLE IF NOT EXISTS "marketing_attribution" (
  "user_id" text PRIMARY KEY REFERENCES "users_app"("id") ON DELETE CASCADE,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "referrer" text,
  "landing_path" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

