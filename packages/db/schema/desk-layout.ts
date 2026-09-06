import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { usersApp } from './users';

export const deskIconPositions = pgTable(
  'desk_icon_positions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    itemKind: text('item_kind').notNull(),
    itemId: text('item_id').notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    writeRevision: bigint('write_revision', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.projectId, t.itemKind, t.itemId] }),
    index('desk_icon_positions_project_idx').on(t.userId, t.projectId),
    check(
      'desk_icon_positions_kind_check',
      sql`${t.itemKind} in ('system', 'folder', 'media', 'script', 'board', 'studio')`,
    ),
    check('desk_icon_positions_x_check', sql`${t.x} >= 0 and ${t.x} <= 100000`),
    check('desk_icon_positions_y_check', sql`${t.y} >= 0 and ${t.y} <= 100000`),
    check('desk_icon_positions_revision_check', sql`${t.writeRevision} >= 0`),
  ],
);

export type DeskIconPosition = typeof deskIconPositions.$inferSelect;
