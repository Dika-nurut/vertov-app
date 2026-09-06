import { index, integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { usersApp } from './users';
import { projects } from './projects';

/**
 * «Доска» — the project workspace: an infinite canvas where generations
 * live as cards, iteration actions draw lineage edges, scene frames group
 * shots and a montage tray feeds the studio editor. `state` is the
 * client-owned canvas document (cards/scenes/tray/viewport); the server
 * treats it as opaque, size-capped JSON. A board is moved to the trash by
 * setting `trashedAt`; the reaper is the only path that permanently removes
 * it after the retention window.
 */
export const boards = pgTable(
  'boards',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull().default('Новый проект'),
    state: jsonb('state').notNull().default({}),
    // Раскадровка read-only share link (previz S5): non-null = shared.
    shareToken: text('share_token').unique(),
    /** Soft-delete marker. NULL means the board is active. */
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    /** Last known state retained while the corrupt-state reset path is used. */
    stateBackup: jsonb('state_backup').$type<Record<string, unknown> | null>(),
    stateBackupAt: timestamp('state_backup_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('boards_user_id_idx').on(t.userId),
    index('boards_user_trash_idx').on(t.userId, t.trashedAt, t.updatedAt),
  ],
);

export const boardSnapshotReasonEnum = pgEnum('board_snapshot_reason', [
  'autosave',
  'manual',
  'pre-destructive',
]);

/** Append-only, user-visible board recovery history. */
export const boardSnapshots = pgTable(
  'board_snapshots',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    rev: integer('rev').notNull(),
    state: jsonb('state').notNull().$type<Record<string, unknown>>(),
    reason: boardSnapshotReasonEnum('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('board_snapshots_board_created_idx').on(t.boardId, t.createdAt, t.id)],
);

export type Board = typeof boards.$inferSelect;
export type BoardSnapshot = typeof boardSnapshots.$inferSelect;
