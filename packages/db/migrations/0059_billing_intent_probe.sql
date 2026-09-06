-- W1-0 — bound the "is this blocking payment already dead?" question.
--
-- Forward-only and additive: one nullable timestamp, no default, no backfill.
-- NULL means "never asked", which is the correct starting point for every
-- existing row. Nothing reads it except the checkout refusal path.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "intent_probed_at" timestamp with time zone;
