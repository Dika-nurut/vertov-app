CREATE TABLE "desk_icon_positions" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"write_revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desk_icon_positions_user_id_project_id_item_kind_item_id_pk" PRIMARY KEY("user_id","project_id","item_kind","item_id"),
	CONSTRAINT "desk_icon_positions_kind_check" CHECK ("desk_icon_positions"."item_kind" in ('system', 'folder', 'media', 'script', 'board', 'studio')),
	CONSTRAINT "desk_icon_positions_x_check" CHECK ("desk_icon_positions"."x" >= 0 and "desk_icon_positions"."x" <= 100000),
	CONSTRAINT "desk_icon_positions_y_check" CHECK ("desk_icon_positions"."y" >= 0 and "desk_icon_positions"."y" <= 100000),
	CONSTRAINT "desk_icon_positions_revision_check" CHECK ("desk_icon_positions"."write_revision" >= 0)
);
--> statement-breakpoint
DROP INDEX "folders_project_name_uidx";--> statement-breakpoint
DROP INDEX "folders_project_ord_idx";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "trash_manifest" jsonb;--> statement-breakpoint
UPDATE "projects" p
SET
  "purge_after" = p."deleted_at" + interval '30 days',
  "trash_manifest" = jsonb_build_object(
    'version', 1,
    'scripts', COALESCE((SELECT jsonb_agg(s."id") FROM "scripts" s WHERE s."project_id" = p."id" AND s."user_id" = p."user_id"), '[]'::jsonb),
    'boards', COALESCE((SELECT jsonb_agg(b."id") FROM "boards" b WHERE b."project_id" = p."id" AND b."user_id" = p."user_id"), '[]'::jsonb),
    'studio', COALESCE((SELECT jsonb_agg(sp."id") FROM "studio_projects" sp WHERE sp."project_id" = p."id" AND sp."user_id" = p."user_id"), '[]'::jsonb),
    'assets', COALESCE((SELECT jsonb_agg(pa."asset_id") FROM "project_assets" pa WHERE pa."project_id" = p."id" AND pa."user_id" = p."user_id"), '[]'::jsonb)
  )
WHERE p."deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "desk_icon_positions" ADD CONSTRAINT "desk_icon_positions_user_id_users_app_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_icon_positions" ADD CONSTRAINT "desk_icon_positions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desk_icon_positions_project_idx" ON "desk_icon_positions" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_id_project_uidx" ON "folders" USING btree ("id","project_id");--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_project_fk" FOREIGN KEY ("parent_id","project_id") REFERENCES "public"."folders"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_purge_after_idx" ON "projects" USING btree ("purge_after");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_project_root_name_uidx" ON "folders" USING btree ("project_id","name") WHERE "folders"."parent_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_project_parent_name_uidx" ON "folders" USING btree ("project_id","parent_id","name") WHERE "folders"."parent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "folders_project_parent_ord_idx" ON "folders" USING btree ("project_id","parent_id","ord","created_at");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_trash_state_check" CHECK (("projects"."deleted_at" is null and "projects"."purge_after" is null and "projects"."trash_manifest" is null)
        or ("projects"."deleted_at" is not null and (
          ("projects"."purge_after" is null and "projects"."trash_manifest" is null)
          or ("projects"."purge_after" is not null and "projects"."trash_manifest" is not null)
        )));--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_not_self_parent_check" CHECK ("folders"."parent_id" IS NULL OR "folders"."parent_id" <> "folders"."id");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "projects_title_search_idx"
  ON "projects" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "scripts_title_search_idx"
  ON "scripts" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "boards_title_search_idx"
  ON "boards" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "studio_projects_title_search_idx"
  ON "studio_projects" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "gallery_items_search_idx"
  ON "gallery_items" USING gin (
    lower(coalesce("title", '') || ' ' || coalesce("original_name", '')) gin_trgm_ops
  );
