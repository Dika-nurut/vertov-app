import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { eq, inArray, like } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  assetPlacements,
  assetReferences,
  db,
  folders,
  galleryItems,
  nid,
  pool,
  projectAssets,
  projects,
  usersApp,
} from '@seed/db';
import { startGalleryReaper } from './gallery-reaper';
import type { AssetStorage } from './storage';

const PREFIX = 'it-galleryreap-';
const tag = (label: string) => `${PREFIX}${label}-${nid()}`;
const log = pino({ level: 'silent' });

async function cleanup(): Promise<void> {
  const itemRows = await db
    .select({ id: galleryItems.id })
    .from(galleryItems)
    .where(like(galleryItems.id, `${PREFIX}%`));
  const itemIds = itemRows.map((row) => row.id);
  if (itemIds.length > 0) {
    await db.delete(projectAssets).where(inArray(projectAssets.assetId, itemIds));
    await db.delete(assetPlacements).where(inArray(assetPlacements.assetId, itemIds));
    await db.delete(assetReferences).where(inArray(assetReferences.galleryItemId, itemIds));
    await db.delete(galleryItems).where(inArray(galleryItems.id, itemIds));
  }
  await db.delete(folders).where(like(folders.id, `${PREFIX}%`));
  await db.delete(projects).where(like(projects.id, `${PREFIX}%`));
  await db.delete(usersApp).where(like(usersApp.id, `${PREFIX}%`));
}

beforeEach(async () => {
  vi.useFakeTimers();
  await cleanup();
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

afterAll(async () => {
  await pool.end();
});

describe('gallery reaper retention clock', () => {
  it('deletes every expired free row, including filed and production-referenced media', async () => {
    const userId = tag('user');
    const projectId = tag('project');
    const folderId = tag('folder');
    const expiredAt = new Date(Date.now() - 60_000);
    const unreferencedId = tag('unreferenced');
    const referencedId = tag('referenced');
    const placementOnlyId = tag('placement-only');
    const memberOnlyId = tag('member-only');
    await db.insert(usersApp).values({ id: userId, tier: 'free' });
    await db.insert(projects).values({ id: projectId, userId, title: 'Архив' });
    await db.insert(folders).values({ id: folderId, projectId, userId, name: 'Отбор' });
    await db.insert(galleryItems).values(
      [unreferencedId, referencedId, placementOnlyId, memberOnlyId].map((id) => ({
        id,
        userId,
        originProjectId: projectId,
        assetUrl: `http://127.0.0.1:9000/seed-assets/${id}.png`,
        thumbnailUrl:
          id === referencedId ? `http://127.0.0.1:9000/seed-assets/${id}-thumb.jpg` : null,
        kind: 'image' as const,
        sourceKind: 'upload',
        expiresAt: expiredAt,
      })),
    );
    await db.insert(assetReferences).values({
      id: tag('reference'),
      galleryItemId: referencedId,
      userId,
      refType: 'board_node',
      refId: tag('board'),
    });
    await db.insert(assetPlacements).values({ assetId: placementOnlyId, folderId });
    await db.insert(projectAssets).values({ projectId, assetId: memberOnlyId, userId });
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, memberOnlyId)),
    ).toHaveLength(1);

    const removed: string[] = [];
    const storage = {
      keyFromUrl: (url: string) => url.split('/').at(-1) ?? null,
      listKeys: async () => [],
      removeObjects: async (keys: string[]) => {
        removed.push(...keys);
      },
    } as unknown as AssetStorage;
    const redis = { set: async () => 'OK' } as unknown as Redis;
    const handle = startGalleryReaper({ log, redis, storage, firstTickDelayMs: 60_000 });
    try {
      await expect(handle.tick()).resolves.toEqual({ deleted: 4, objectsRemoved: 5 });
    } finally {
      handle.stop();
    }

    expect(
      await db.select().from(galleryItems).where(eq(galleryItems.id, unreferencedId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(galleryItems).where(eq(galleryItems.id, referencedId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(galleryItems).where(eq(galleryItems.id, placementOnlyId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(galleryItems).where(eq(galleryItems.id, memberOnlyId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, memberOnlyId)),
    ).toHaveLength(0);
    // The referenced image carries an explicit thumbnail. Missing sidecars
    // are harmless S3 deletes, but any existing derived object is included so
    // it cannot survive the parent asset's expiry.
    expect(removed).toHaveLength(5);
    expect(removed).toEqual(
      expect.arrayContaining([
        `${unreferencedId}.png`,
        `${referencedId}.png`,
        `${referencedId}-thumb.jpg`,
        `${placementOnlyId}.png`,
        `${memberOnlyId}.png`,
      ]),
    );
  });

  it('retains an expired row when storage cleanup fails, then deletes it on retry', async () => {
    const userId = tag('retry-user');
    const assetId = tag('retry-asset');
    const expiredAt = new Date(Date.now() - 60_000);
    await db.insert(usersApp).values({ id: userId, tier: 'free' });
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `http://127.0.0.1:9000/seed-assets/${assetId}.mp4`,
      kind: 'video',
      expiresAt: expiredAt,
    });

    let attempts = 0;
    const storage = {
      keyFromUrl: (url: string) => url.split('/').at(-1) ?? null,
      listKeys: async () => [],
      removeObjects: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary object-store outage');
      },
    } as unknown as AssetStorage;
    const redis = { set: async () => 'OK' } as unknown as Redis;
    const handle = startGalleryReaper({ log, redis, storage, firstTickDelayMs: 60_000 });
    try {
      await expect(handle.tick()).resolves.toEqual({ deleted: 0, objectsRemoved: 0 });
      expect(await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))).toHaveLength(
        1,
      );

      await expect(handle.tick()).resolves.toEqual({ deleted: 1, objectsRemoved: 3 });
      expect(await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))).toHaveLength(
        0,
      );
      expect(attempts).toBe(2);
    } finally {
      handle.stop();
    }
  });

  it('retries raw objects for soft-deleted accounts, including multipart chunks', async () => {
    const userId = tag('erased-user');
    await db.insert(usersApp).values({ id: userId, tier: 'free', status: 'deleted' });

    const prefixes: string[] = [];
    let attempts = 0;
    const removed: string[] = [];
    const storage = {
      keyFromUrl: () => null,
      listKeys: async (prefix: string) => {
        prefixes.push(prefix);
        return prefix === `${userId}/`
          ? [`${userId}/video/source.mp4`, `${userId}/video/source.mp4.peaks.json`]
          : [`_mp/${userId}/upload/0`];
      },
      removeObjects: async (keys: string[]) => {
        attempts += 1;
        if (attempts <= 2) throw new Error('temporary object-store outage');
        removed.push(...keys);
      },
    } as unknown as AssetStorage;
    const redis = { set: async () => 'OK' } as unknown as Redis;
    const handle = startGalleryReaper({ log, redis, storage, firstTickDelayMs: 60_000 });
    try {
      await expect(handle.tick()).resolves.toEqual({ deleted: 0, objectsRemoved: 0 });
      await expect(handle.tick()).resolves.toEqual({ deleted: 0, objectsRemoved: 3 });
      await expect(handle.tick()).resolves.toEqual({ deleted: 0, objectsRemoved: 0 });
    } finally {
      handle.stop();
    }

    expect(prefixes).toEqual([`${userId}/`, `_mp/${userId}/`, `${userId}/`, `_mp/${userId}/`]);
    expect(attempts).toBe(4);
    const [erased] = await db
      .select({ clearedAt: usersApp.erasureObjectsClearedAt })
      .from(usersApp)
      .where(eq(usersApp.id, userId));
    expect(erased?.clearedAt).toBeInstanceOf(Date);
    expect(removed).toEqual([
      `${userId}/video/source.mp4`,
      `${userId}/video/source.mp4.peaks.json`,
      `_mp/${userId}/upload/0`,
    ]);
  });
});
