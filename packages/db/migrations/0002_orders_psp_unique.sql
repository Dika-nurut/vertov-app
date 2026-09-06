CREATE UNIQUE INDEX IF NOT EXISTS "orders_psp_payment_id_unique"
	ON "orders" ("psp_payment_id")
	WHERE "psp_payment_id" IS NOT NULL;
