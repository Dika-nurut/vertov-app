CREATE TABLE IF NOT EXISTS "credit_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"credits" integer NOT NULL,
	"price_rub" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_jobs_pending_idx"
	ON "outbox_jobs" ("queue_name", "created_at")
	WHERE "processed_at" IS NULL;
