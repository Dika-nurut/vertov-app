CREATE TABLE "assist_tier_states" (
	"tier_id" text PRIMARY KEY NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
