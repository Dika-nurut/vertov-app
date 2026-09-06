import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { usersApp } from './users';

export interface ProductionFormat {
  aspect: string;
  note?: string | undefined;
}

export const PROJECT_TRASH_RETENTION_DAYS = 30;
export const PROJECT_TRASH_RETENTION_MS = PROJECT_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Point-in-time membership inventory captured by the delete transaction.
 *
 * Project relationships themselves stay in their canonical tables throughout
 * retention. This inventory is deliberately not a backup copy of document
 * content: it lets restore compare what existed at deletion with what still
 * exists, so independently expired media or explicitly removed documents are
 * reported honestly as a partial restoration.
 */
export interface ProjectTrashManifest {
  version: 1;
  scripts: string[];
  boards: string[];
  studio: string[];
  assets: string[];
}

/** Stable identity shared by Scenario, Boards, Studio, and project assets. */
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Новый проект'),
    productionFormat: jsonb('production_format')
      .notNull()
      .$type<ProductionFormat>()
      .default({ aspect: '16:9' }),
    primaryScriptId: text('primary_script_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    trashManifest: jsonb('trash_manifest').$type<ProjectTrashManifest>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('projects_user_id_idx').on(t.userId),
    index('projects_deleted_at_idx').on(t.deletedAt),
    index('projects_purge_after_idx').on(t.purgeAfter),
    check(
      'projects_trash_state_check',
      sql`(${t.deletedAt} is null and ${t.purgeAfter} is null and ${t.trashManifest} is null)
        or (${t.deletedAt} is not null and (
          (${t.purgeAfter} is null and ${t.trashManifest} is null)
          or (${t.purgeAfter} is not null and ${t.trashManifest} is not null)
        ))`,
    ),
  ],
);

export type Project = typeof projects.$inferSelect;
