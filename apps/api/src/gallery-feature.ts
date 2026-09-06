import { and, eq, isNull, not, sql } from 'drizzle-orm';
import { db as defaultDb, galleryItems } from '@seed/db';

type DbLike = typeof defaultDb;

/**
 * Feature or unfeature one owner's already-public gallery item.
 *
 * Featuring is an operator decision to keep an item in the public showcase,
 * so it pins the row outside the finite free-tier retention clock. Unfeaturing
 * does not resurrect a prior deadline: the previous deadline is intentionally
 * not retained once the item has been chosen for curation.
 */
export async function setGalleryItemFeatured(
  database: DbLike,
  input: { itemId: string; userId: string; featured: boolean; now?: Date },
): Promise<{ id: string } | null> {
  const featuredAt = input.featured ? (input.now ?? new Date()) : null;
  const [row] = await database
    .update(galleryItems)
    .set(input.featured ? { featuredAt, expiresAt: null } : { featuredAt })
    .where(
      and(
        eq(galleryItems.id, input.itemId),
        eq(galleryItems.userId, input.userId),
        eq(galleryItems.isPublic, true),
        isNull(galleryItems.deletedAt),
        isNull(galleryItems.moderationTakedownAt),
        // Provider-flagged output must never enter a public curation surface.
        not(sql`${galleryItems.tags} @> ARRAY['nsfw']::text[]`),
      ),
    )
    .returning({ id: galleryItems.id });
  return row ?? null;
}
