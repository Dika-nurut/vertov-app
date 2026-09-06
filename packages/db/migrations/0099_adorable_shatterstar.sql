CREATE TABLE "script_shot_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"script_id" text NOT NULL,
	"source_scene_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"target_duration_seconds" integer NOT NULL,
	"policy_version" text NOT NULL,
	"model_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"credits_spent" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "script_shot_plans" ADD CONSTRAINT "script_shot_plans_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "script_shot_plans_cache_uidx" ON "script_shot_plans" USING btree ("script_id","source_scene_id","source_hash","target_duration_seconds");--> statement-breakpoint
CREATE INDEX "script_shot_plans_script_scene_idx" ON "script_shot_plans" USING btree ("script_id","source_scene_id","created_at");