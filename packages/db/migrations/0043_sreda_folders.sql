CREATE TABLE "asset_deletion_leases" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"previous_expires_at" timestamp with time zone,
	"delete_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_placements" (
	"asset_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_placements_asset_id_folder_id_pk" PRIMARY KEY("asset_id","folder_id")
);
--> statement-breakpoint
CREATE TABLE "asset_references" (
	"id" text PRIMARY KEY NOT NULL,
	"gallery_item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_references_ref_type_check" CHECK ("asset_references"."ref_type" in ('studio_clip', 'board_node', 'keep'))
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "original_name" text;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "checksum" text;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_deletion_leases" ADD CONSTRAINT "asset_deletion_leases_asset_id_gallery_items_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gallery_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_deletion_leases" ADD CONSTRAINT "asset_deletion_leases_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_placements" ADD CONSTRAINT "asset_placements_asset_id_gallery_items_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gallery_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_placements" ADD CONSTRAINT "asset_placements_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_gallery_item_id_gallery_items_id_fk" FOREIGN KEY ("gallery_item_id") REFERENCES "public"."gallery_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_placements_asset_folder_uidx" ON "asset_placements" USING btree ("asset_id","folder_id");--> statement-breakpoint
CREATE INDEX "asset_placements_folder_idx" ON "asset_placements" USING btree ("folder_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_references_item_type_ref_uidx" ON "asset_references" USING btree ("gallery_item_id","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "asset_references_item_idx" ON "asset_references" USING btree ("gallery_item_id");--> statement-breakpoint
CREATE INDEX "asset_references_user_idx" ON "asset_references" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_project_name_uidx" ON "folders" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "folders_project_ord_idx" ON "folders" USING btree ("project_id","ord","created_at");
