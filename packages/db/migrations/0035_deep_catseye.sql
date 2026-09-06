ALTER TABLE "script_assist_requests" DROP CONSTRAINT "script_assist_requests_script_id_scripts_id_fk";
--> statement-breakpoint
ALTER TABLE "script_assist_requests" ALTER COLUMN "script_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "script_assist_requests" ADD CONSTRAINT "script_assist_requests_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "script_assist_requests_inflight_age_idx" ON "script_assist_requests" USING btree ("created_at") WHERE "script_assist_requests"."status" = 'in_progress';