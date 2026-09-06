import { and, count, eq, isNull } from 'drizzle-orm';
import {
  assetPlacements,
  assetReferences,
  db,
  galleryItems,
  projectAssets,
  projects,
} from '@seed/db';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class AssetMembershipError extends Error {
  readonly status = 404;
  readonly body = { error: 'not_found' } as const;

  constructor() {
    super('not_found');
  }
}

export async function ensureMembership(
  tx: Transaction,
  projectId: string,
  assetId: string,
  userId: string,
): Promise<boolean> {
  const [[project], [asset]] = await Promise.all([
    tx
      .select({ id: projects.id, userId: projects.userId })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1),
    tx
      .select({ id: galleryItems.id, userId: galleryItems.userId })
      .from(galleryItems)
      .where(and(eq(galleryItems.id, assetId), isNull(galleryItems.deletedAt)))
      .limit(1),
  ]);
  if (!project || !asset || project.userId !== userId || asset.userId !== userId) {
    throw new AssetMembershipError();
  }
  const inserted = await tx
    .insert(projectAssets)
    .values({ projectId: project.id, assetId: asset.id, userId: project.userId })
    .onConflictDoNothing()
    .returning({ assetId: projectAssets.assetId });
  return inserted.length === 1;
}

export async function releaseKeepIfUnplaced(tx: Transaction, assetId: string): Promise<void> {
  const [remaining] = await tx
    .select({ value: count() })
    .from(assetPlacements)
    .where(eq(assetPlacements.assetId, assetId));
  if ((remaining?.value ?? 0) > 0) return;
  await tx
    .delete(assetReferences)
    .where(
      and(
        eq(assetReferences.galleryItemId, assetId),
        eq(assetReferences.refType, 'keep'),
        eq(assetReferences.refId, 'folder-placement'),
      ),
    );
}
