CREATE TABLE "model_price_points" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"resolution" text DEFAULT 'default' NOT NULL,
	"video_input" boolean DEFAULT false NOT NULL,
	"audio" boolean DEFAULT false NOT NULL,
	"unit_kind" "unit_kind" NOT NULL,
	"base_credits" integer NOT NULL,
	"base_units" integer DEFAULT 1 NOT NULL,
	"source_ref" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_price_points_config_uq" UNIQUE("model_id","resolution","video_input","audio"),
	CONSTRAINT "model_price_points_base_credits_positive" CHECK ("model_price_points"."base_credits" > 0),
	CONSTRAINT "model_price_points_base_units_positive" CHECK ("model_price_points"."base_units" > 0)
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "credit_unit_cost" integer;--> statement-breakpoint
ALTER TABLE "model_price_points" ADD CONSTRAINT "model_price_points_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_price_points_model_idx" ON "model_price_points" USING btree ("model_id");