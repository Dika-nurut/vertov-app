DROP INDEX "script_assist_requests_user_inflight_uidx";--> statement-breakpoint
ALTER TABLE "script_assist_requests" ADD COLUMN "op" text DEFAULT 'assist' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "script_assist_requests_user_op_inflight_uidx" ON "script_assist_requests" USING btree ("user_id","op") WHERE "script_assist_requests"."status" = 'in_progress';