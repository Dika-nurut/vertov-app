-- Better Auth anonymous() plugin: flag instant-guest sessions.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "is_anonymous" boolean DEFAULT false;
