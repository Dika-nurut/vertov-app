ALTER TABLE "scripts" ADD COLUMN "format" text DEFAULT 'film' NOT NULL;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "brief" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "outline" jsonb DEFAULT '{"version":1,"beats":[]}'::jsonb NOT NULL;