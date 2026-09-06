ALTER TABLE "jobs" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "studio_renders" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_renders" ADD CONSTRAINT "studio_renders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_project_id_idx" ON "jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "studio_renders_project_id_idx" ON "studio_renders" USING btree ("project_id");