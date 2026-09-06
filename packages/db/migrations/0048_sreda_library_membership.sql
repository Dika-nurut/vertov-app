CREATE TABLE "project_assets" (
	"project_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_assets_project_id_asset_id_pk" PRIMARY KEY("project_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "gallery_items" RENAME COLUMN "project_id" TO "origin_project_id";--> statement-breakpoint
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_asset_id_gallery_items_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gallery_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_assets_project_added_idx" ON "project_assets" USING btree ("project_id","added_at" DESC NULLS LAST,"asset_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_assets_asset_idx" ON "project_assets" USING btree ("asset_id");
