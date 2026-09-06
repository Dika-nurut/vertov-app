DROP INDEX "gallery_items_project_created_idx";--> statement-breakpoint
DROP INDEX "gallery_items_project_checksum_idx";--> statement-breakpoint
DROP INDEX "gallery_items_project_checksum_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "gallery_items_user_checksum_uidx" ON "gallery_items" USING btree ("user_id","checksum") WHERE "gallery_items"."checksum" is not null and "gallery_items"."deleted_at" is null;