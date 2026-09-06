ALTER TABLE "models" ADD COLUMN "gateway_override" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "fallback_gateway" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "gateway_used" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "used_fallback" boolean DEFAULT false NOT NULL;