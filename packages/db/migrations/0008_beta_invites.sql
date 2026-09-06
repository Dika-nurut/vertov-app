-- W4.Fri: beta invite codes table for closed beta launch.
-- beta_invites references users_app(id) only — no PII columns directly.
-- 152-ФЗ compliance: email/PII stays in users_pii; this table holds only
-- the user's opaque id + cohort tag + timestamps.
CREATE TABLE IF NOT EXISTS "beta_invites" (
  "code"              text        PRIMARY KEY,
  "cohort"            text        NOT NULL,
  "created_at"        timestamptz DEFAULT now() NOT NULL,
  "used_at"           timestamptz,
  "used_by_user_id"   text        REFERENCES "users_app"("id") ON DELETE SET NULL
);

-- Index for fast lookup by user (GET /v1/beta/me)
CREATE INDEX IF NOT EXISTS "beta_invites_used_by_user_id_idx"
  ON "beta_invites" ("used_by_user_id");
