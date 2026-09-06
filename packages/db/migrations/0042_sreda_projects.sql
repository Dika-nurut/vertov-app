CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT 'Новый проект' NOT NULL,
	"production_format" jsonb DEFAULT '{"aspect":"16:9"}'::jsonb NOT NULL,
	"primary_script_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "studio_projects" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_deleted_at_idx" ON "projects" USING btree ("deleted_at");--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_projects" ADD CONSTRAINT "studio_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;