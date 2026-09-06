import 'dotenv/config';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, galleryItems, nid, pool, usersApp } from '@seed/db';
import { setGalleryItemFeatured } from '../src/gallery-feature';

const createdUsers: string[] = [];
const createdItems: string[] = [];

afterEach(async () => {
  if (createdItems.length > 0) {
    await db.delete(galleryItems).where(inArray(galleryItems.id, createdItems));
    createdItems.length = 0;
  }
  if (createdUsers.length > 0) {
    await db.delete(usersApp).where(inArray(usersApp.id, createdUsers));
    createdUsers.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

describe('showcase feature retention pin', () => {
  it('pins finite media when featured and keeps the pin after unfeaturing', async () => {
    const userId = nid();
    const itemId = nid();
    createdUsers.push(userId);
    createdItems.push(itemId);
    await db.insert(usersApp).values({ id: userId, displayName: 'Feature test', locale: 'ru' });
    await db.insert(galleryItems).values({
      id: itemId,
      userId,
      assetUrl: `https://assets.seed.local/${itemId}.png`,
      kind: 'image',
      isPublic: true,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(setGalleryItemFeatured(db, { itemId, userId, featured: true })).resolves.toEqual({
      id: itemId,
    });
    const [featured] = await db
      .select({ featuredAt: galleryItems.featuredAt, expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(eq(galleryItems.id, itemId));
    expect(featured?.featuredAt).toBeInstanceOf(Date);
    expect(featured?.expiresAt).toBeNull();

    await expect(setGalleryItemFeatured(db, { itemId, userId, featured: false })).resolves.toEqual({
      id: itemId,
    });
    const [unfeatured] = await db
      .select({ featuredAt: galleryItems.featuredAt, expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(eq(galleryItems.id, itemId));
    expect(unfeatured?.featuredAt).toBeNull();
    expect(unfeatured?.expiresAt).toBeNull();
  });

  it('refuses deleted, taken-down, and provider-flagged items', async () => {
    const userId = nid();
    createdUsers.push(userId);
    await db.insert(usersApp).values({ id: userId, displayName: 'Feature test', locale: 'ru' });
    const blocked = [
      { reason: 'deleted', deletedAt: new Date() },
      { reason: 'takedown', moderationTakedownAt: new Date() },
      { reason: 'provider flag', tags: ['nsfw'] },
    ] as const;
    for (const state of blocked) {
      const itemId = nid();
      createdItems.push(itemId);
      await db.insert(galleryItems).values({
        id: itemId,
        userId,
        assetUrl: `https://assets.seed.local/${itemId}.png`,
        kind: 'image',
        isPublic: true,
        expiresAt: new Date(Date.now() + 60_000),
        ...(state.deletedAt ? { deletedAt: state.deletedAt } : {}),
        ...(state.moderationTakedownAt ? { moderationTakedownAt: state.moderationTakedownAt } : {}),
        ...(state.tags ? { tags: state.tags } : {}),
      });
      await expect(
        setGalleryItemFeatured(db, { itemId, userId, featured: true }),
        state.reason,
      ).resolves.toBeNull();
    }
  });
});
