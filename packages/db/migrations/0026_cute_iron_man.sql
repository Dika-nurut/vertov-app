CREATE TABLE "script_thread_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"script_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"proposal" jsonb,
	"tier" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "script_thread_messages" ADD CONSTRAINT "script_thread_messages_thread_id_script_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."script_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_thread_messages" ADD CONSTRAINT "script_thread_messages_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_thread_messages" ADD CONSTRAINT "script_thread_messages_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "script_thread_messages_thread_cursor_idx" ON "script_thread_messages" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "script_thread_messages_script_user_idx" ON "script_thread_messages" USING btree ("script_id","user_id","created_at");