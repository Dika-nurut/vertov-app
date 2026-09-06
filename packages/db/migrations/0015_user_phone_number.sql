-- Better Auth phoneNumber() plugin: phone-number sign-in / OTP (RU flash-call).
-- Nullable so existing anon/email/OAuth users are unaffected; unique enforces one
-- account per verified phone (Postgres allows many NULLs under a UNIQUE index).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phone_number" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phone_number_verified" boolean DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "user_phone_number_unique" ON "user" ("phone_number");
