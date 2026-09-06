CREATE TABLE "script_assist_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"script_id" text NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"thread_id" text,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "script_assist_requests" ADD CONSTRAINT "script_assist_requests_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_assist_requests" ADD CONSTRAINT "script_assist_requests_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_assist_requests" ADD CONSTRAINT "script_assist_requests_thread_id_script_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."script_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "script_assist_requests_user_key_uidx" ON "script_assist_requests" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "script_assist_requests_script_id_idx" ON "script_assist_requests" USING btree ("script_id","created_at");
