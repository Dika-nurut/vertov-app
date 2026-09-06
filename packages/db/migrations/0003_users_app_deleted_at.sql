-- Soft-delete tombstone on users_app. Hard delete still happens on
-- users_pii in the same tx (DELETE /v1/me), satisfying 152-ФЗ while
-- letting us keep referential integrity for credit_transactions and
-- jobs that reference the user id.
ALTER TABLE "users_app" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
