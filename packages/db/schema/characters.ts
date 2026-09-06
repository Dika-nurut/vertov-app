import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { usersApp } from './users';

/**
 * «Персонажи» — named sets of 1–4 reference images for character
 * consistency without training: applying a character injects its images
 * into the generate screen's reference pool (Seedream multi-reference /
 * Seedance i2v do the rest).
 */
export const characters = pgTable(
  'characters',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    imageUrls: jsonb('image_urls').notNull().$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('characters_user_id_idx').on(t.userId)],
);

export type Character = typeof characters.$inferSelect;
