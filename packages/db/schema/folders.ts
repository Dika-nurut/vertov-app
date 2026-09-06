import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { galleryItems } from './gallery';
import { projects } from './projects';
import { usersApp } from './users';

export const folders = pgTable(
  'folders',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    ord: integer('ord').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('folders_id_project_uidx').on(t.id, t.projectId),
    uniqueIndex('folders_project_root_name_uidx')
      .on(t.projectId, t.name)
      .where(sql`${t.parentId} IS NULL`),
    uniqueIndex('folders_project_parent_name_uidx')
      .on(t.projectId, t.parentId, t.name)
      .where(sql`${t.parentId} IS NOT NULL`),
    foreignKey({
      name: 'folders_parent_project_fk',
      columns: [t.parentId, t.projectId],
      foreignColumns: [t.id, t.projectId],
    }).onDelete('cascade'),
    check('folders_not_self_parent_check', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    index('folders_project_parent_ord_idx').on(t.projectId, t.parentId, t.ord, t.createdAt),
  ],
);

export const assetPlacements = pgTable(
  'asset_placements',
  {
    assetId: text('asset_id')
      .notNull()
      .references(() => galleryItems.id, { onDelete: 'restrict' }),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.folderId] }),
    uniqueIndex('asset_placements_asset_folder_uidx').on(t.assetId, t.folderId),
    index('asset_placements_folder_idx').on(t.folderId, t.createdAt),
  ],
);

export const assetReferences = pgTable(
  'asset_references',
  {
    id: text('id').primaryKey(),
    galleryItemId: text('gallery_item_id')
      .notNull()
      .references(() => galleryItems.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    refType: text('ref_type').notNull(),
    refId: text('ref_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'asset_references_ref_type_check',
      sql`${t.refType} in ('studio_clip', 'board_node', 'keep')`,
    ),
    uniqueIndex('asset_references_item_type_ref_uidx').on(t.galleryItemId, t.refType, t.refId),
    index('asset_references_item_idx').on(t.galleryItemId),
    index('asset_references_user_idx').on(t.userId),
  ],
);

/** Persists the pre-delete expiry so the short undo action is honest. */
export const assetDeletionLeases = pgTable('asset_deletion_leases', {
  assetId: text('asset_id')
    .primaryKey()
    .references(() => galleryItems.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => usersApp.id, { onDelete: 'cascade' }),
  previousExpiresAt: timestamp('previous_expires_at', { withTimezone: true }),
  folderIds: jsonb('folder_ids').notNull().$type<string[]>().default([]),
  deleteAfter: timestamp('delete_after', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
