import { sql } from 'drizzle-orm';
import { bigint, boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { galleryKindEnum } from './enums';
import { jobs } from './jobs';
import { usersApp } from './users';
import { projects } from './projects';

export const galleryItems = pgTable(
  'gallery_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    originProjectId: text('origin_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    // Nullable: studio renders (server-side ffmpeg assembly) produce gallery
    // items that have no source AI job.
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    assetUrl: text('asset_url').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    kind: galleryKindEnum('kind').notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    title: text('title'),
    /** Stable provenance used by the project desk's chronological view. */
    sourceKind: text('source_kind'),
    originalName: text('original_name'),
    mimeType: text('mime_type'),
    checksum: text('checksum'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    promptVisible: boolean('prompt_visible').notNull().default(true),
    /** User-defined folder name; NULL = "Без папки" pseudo-folder. */
    folder: text('folder'),
    /** Free-form tags. Empty array by default. */
    tags: text('tags').array().notNull().default(sqlEmptyArray()),
    /** Minted lazily on first publish (W3.Thu). NULL → not yet public. */
    publicSlug: text('public_slug'),
    /** Free-tier auto-delete: now() + 30 days at insert time. NULL on paid tiers. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Hidden immediately while the short guarded-delete undo lease runs. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** Durable operator block: a takedown cannot be undone by owner republish. */
    moderationTakedownAt: timestamp('moderation_takedown_at', { withTimezone: true }),
    /** Curation marker: human-approved for the public showcase feed. The
     * anti-slop lever — only featured items appear on /showcase. */
    featuredAt: timestamp('featured_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('gallery_user_id_idx').on(t.userId),
    index('gallery_job_id_idx').on(t.jobId),
    index('gallery_public_idx').on(t.isPublic, t.publishedAt),
    index('gallery_items_user_folder_idx').on(t.userId, t.folder),
    index('gallery_items_expires_at_idx').on(t.expiresAt),
    index('gallery_items_featured_idx').on(t.featuredAt),
    uniqueIndex('gallery_items_user_checksum_uidx')
      .on(t.userId, t.checksum)
      .where(sql`${t.checksum} is not null and ${t.deletedAt} is null`),
  ],
);

/**
 * Drizzle quirk: postgres array column defaults need a SQL literal, not
 * a JS empty array. `sql\`'{}'::text[]\`` works but adds a typecheck wart.
 * We declare the default inline as a typed empty array via the helper
 * pattern used elsewhere in the codebase.
 */
function sqlEmptyArray() {
  // Postgres literal for an empty text[] without explicit cast.
  return [] as string[];
}
