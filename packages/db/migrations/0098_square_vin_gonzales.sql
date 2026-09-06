CREATE TABLE "script_scene_timings" (
	"id" text PRIMARY KEY NOT NULL,
	"script_id" text NOT NULL,
	"source_unit_id" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"owner" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"estimator_policy_version" text NOT NULL,
	"supersedes_timing_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "script_scene_timings_duration_positive_ck" CHECK ("script_scene_timings"."duration_seconds" > 0 AND "script_scene_timings"."duration_seconds" <= 7200),
	CONSTRAINT "script_scene_timings_owner_ck" CHECK ("script_scene_timings"."owner" IN ('vertov', 'user'))
);
--> statement-breakpoint
ALTER TABLE "script_scene_timings" ADD CONSTRAINT "script_scene_timings_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "script_scene_timings_script_unit_idx" ON "script_scene_timings" USING btree ("script_id","source_unit_id","created_at");--> statement-breakpoint
CREATE INDEX "script_scene_timings_script_created_idx" ON "script_scene_timings" USING btree ("script_id","created_at");