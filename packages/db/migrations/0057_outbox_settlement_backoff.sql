ALTER TABLE "outbox_jobs" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;
