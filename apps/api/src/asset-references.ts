import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { assetReferences, db, galleryItems, nid } from '@seed/db';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Transaction;

export interface IdentifiedAssetReference {
  assetId: string;
  slotId: string;
}

export interface ResolvedOwnedAsset {
  id: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  kind: 'image' | 'video' | 'audio';
  title: string | null;
  expiresAt: Date | null;
}

/**
 * What "this owner may access this asset right now" means, as one SQL predicate:
 * theirs, not deleted, not expired.
 *
 * It is the definition every user-facing media read should use: gallery lists,
 * Studio source/caption/render authorization, job-history result URLs, project
 * counts, folders, desk surfaces, and the resolver above. Public showcase
 * routes add their stricter takedown/NSFW predicates in `public-gallery.ts`;
 * `search.ts` keeps an equivalent SQL copy because its query is a raw cross-type
 * CTE. Expired rows remain durable receipts only; the reaper is cleanup, not
 * authorization.
 */
export function availableOwnedAssetCondition(userId: string, now: Date) {
  return and(
    eq(galleryItems.userId, userId),
    isNull(galleryItems.deletedAt),
    or(isNull(galleryItems.expiresAt), gt(galleryItems.expiresAt, now)),
  );
}

/**
 * Resolve only assets that are currently usable by this owner. A caller must
 * treat every omitted id identically: it may be foreign, missing, deleted, or
 * past its finite retention window.
 */
export async function resolveAvailableOwnedAssets(
  tx: DbLike,
  userId: string,
  assetIds: readonly string[],
  now = new Date(),
): Promise<Map<string, ResolvedOwnedAsset>> {
  const unique = [...new Set(assetIds)];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({
      id: galleryItems.id,
      assetUrl: galleryItems.assetUrl,
      thumbnailUrl: galleryItems.thumbnailUrl,
      kind: galleryItems.kind,
      title: galleryItems.title,
      originalName: galleryItems.originalName,
      expiresAt: galleryItems.expiresAt,
    })
    .from(galleryItems)
    .where(and(availableOwnedAssetCondition(userId, now), inArray(galleryItems.id, unique)));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        assetUrl: row.assetUrl,
        thumbnailUrl: row.thumbnailUrl,
        kind: row.kind,
        title: row.title ?? row.originalName,
        expiresAt: row.expiresAt,
      },
    ]),
  );
}

/**
 * Replace one Board/Studio resource's production references atomically. Only
 * IDs owned by the current user enter the shared usage graph. Deleted owned
 * rows remain referentially visible until the gallery row is actually reaped;
 * composing never mutates retention.
 */
export async function syncAssetReferences(
  tx: Transaction,
  input: {
    userId: string;
    refType: 'board_node' | 'studio_clip';
    resourceId: string;
    references: readonly IdentifiedAssetReference[];
  },
): Promise<void> {
  const uniqueAssetIds = [...new Set(input.references.map((ref) => ref.assetId))];
  const owned =
    uniqueAssetIds.length === 0
      ? []
      : await tx
          .select({ id: galleryItems.id })
          .from(galleryItems)
          .where(
            and(eq(galleryItems.userId, input.userId), inArray(galleryItems.id, uniqueAssetIds)),
          );
  const ownedIds = new Set(owned.map((row) => row.id));

  await tx
    .delete(assetReferences)
    .where(
      and(
        eq(assetReferences.userId, input.userId),
        eq(assetReferences.refType, input.refType),
        sql`left(${assetReferences.refId}, length(${`${input.resourceId}:`})) = ${`${input.resourceId}:`}`,
      ),
    );

  const values = input.references
    .filter((ref) => ownedIds.has(ref.assetId))
    .map((ref) => ({
      id: nid(),
      galleryItemId: ref.assetId,
      userId: input.userId,
      refType: input.refType,
      refId: `${input.resourceId}:${ref.slotId}`,
    }));
  if (values.length > 0) {
    await tx.insert(assetReferences).values(values).onConflictDoNothing();
  }
}

export function studioTimelineAssetReferences(timeline: unknown): IdentifiedAssetReference[] {
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) return [];
  const blob = timeline as Record<string, unknown>;
  const clips: unknown[] = [];
  if (Array.isArray(blob.tracks)) {
    for (const track of blob.tracks) {
      if (
        track &&
        typeof track === 'object' &&
        Array.isArray((track as { clips?: unknown }).clips)
      ) {
        clips.push(...((track as { clips: unknown[] }).clips ?? []));
      }
    }
  }
  if (Array.isArray(blob.timeline)) clips.push(...blob.timeline);
  return clips.flatMap((clip, index) => {
    if (!clip || typeof clip !== 'object') return [];
    const row = clip as { assetId?: unknown; uid?: unknown };
    if (typeof row.assetId !== 'string' || row.assetId.length === 0) return [];
    const slotId =
      typeof row.uid === 'string' && row.uid.length > 0 ? row.uid.slice(0, 160) : `clip-${index}`;
    return [{ assetId: row.assetId, slotId }];
  });
}
