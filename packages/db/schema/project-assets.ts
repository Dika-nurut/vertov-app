import { index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { galleryItems } from './gallery';
import { projects } from './projects';
import { usersApp } from './users';

export const projectAssets = pgTable(
  'project_assets',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => galleryItems.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.assetId] }),
    index('project_assets_project_added_idx').on(t.projectId, t.addedAt.desc(), t.assetId.desc()),
    index('project_assets_asset_idx').on(t.assetId),
  ],
);
