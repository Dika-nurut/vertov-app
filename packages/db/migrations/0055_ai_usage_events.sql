CREATE TABLE "ai_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"op" text NOT NULL,
	"route" text NOT NULL,
	"model" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"outcome" text NOT NULL,
	"claim_id" text,
	"script_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"reasoning_tokens" integer,
	"usage_reported" boolean NOT NULL,
	"cost_usd" double precision,
	"cost_source" text,
	"credits_charged" integer,
	"cache_markers_sent" boolean DEFAULT false NOT NULL,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_claim_id_script_assist_requests_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."script_assist_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_events_created_at_idx" ON "ai_usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_op_created_at_idx" ON "ai_usage_events" USING btree ("op","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_route_created_at_idx" ON "ai_usage_events" USING btree ("route","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_events_claim_id_idx" ON "ai_usage_events" USING btree ("claim_id");