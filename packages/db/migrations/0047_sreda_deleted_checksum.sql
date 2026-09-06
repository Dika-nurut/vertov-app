DROP TRIGGER IF EXISTS "gallery_items_reference_delete_guard" ON "gallery_items";--> statement-breakpoint
DROP FUNCTION IF EXISTS "protect_referenced_gallery_item"();--> statement-breakpoint
DROP INDEX IF EXISTS "gallery_items_project_checksum_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "gallery_items_project_checksum_uidx" ON "gallery_items" USING btree ("project_id","checksum") WHERE "gallery_items"."project_id" is not null and "gallery_items"."checksum" is not null and "gallery_items"."deleted_at" is null;
