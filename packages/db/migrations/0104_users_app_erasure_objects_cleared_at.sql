-- Durable progress marker for the bounded account-erasure object-prefix sweep.
-- Keep the soft-delete tombstone for account/session rejection and audit while
-- allowing the worker to advance past accounts whose object prefixes are clear.
ALTER TABLE "users_app"
  ADD COLUMN IF NOT EXISTS "erasure_objects_cleared_at" timestamptz;
