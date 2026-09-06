import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  assetDeletionLeases,
  db,
  galleryItems,
  jobs,
  nid,
  pool,
  usersApp,
  usersPii,
  workflows,
} from '@seed/db';
import { setupFolderRoutes } from '../src/folders';
import { setupGalleryRoutes } from '../src/gallery';
import { setupPublicGalleryRoutes } from '../src/public-gallery';

let app: ReturnType<typeof Fastify>;
let userId: string;
let itemId: string;
let jobId: string;
let workflowId: string;
const slug = `deleted-${nid()}`;

const headers = () => ({ 'x-test-user': userId });

beforeAll(async () => {
  userId = nid();
  workflowId = nid();
  jobId = nid();
  itemId = nid();
  await db.insert(usersApp).values({ id: userId, displayName: 'Deleted surfaces', locale: 'ru' });
  await db.insert(usersPii).values({ id: userId, email: `deleted-surfaces+${userId}@seed.local` });
  await db.insert(workflows).values({
    id: workflowId,
    userId,
    modelId: 'seedream-4-5',
    params: { prompt: 'кадр' },
    referenceAssets: [],
  });
  await db.insert(jobs).values({
    id: jobId,
    userId,
    workflowId,
    modelId: 'seedream-4-5',
    status: 'succeeded',
    creditsReserved: 15,
    idempotencyKey: `deleted-surfaces-${jobId}`,
    resultAssets: [`http://127.0.0.1:9000/seed-assets/${itemId}.png`],
  });
  await db.insert(galleryItems).values({
    id: itemId,
    userId,
    jobId,
    assetUrl: `http://127.0.0.1:9000/seed-assets/${itemId}.png`,
    kind: 'image',
    folder: 'Архив',
    tags: ['featured'],
    isPublic: true,
    publicSlug: slug,
    publishedAt: new Date(),
    featuredAt: new Date(),
  });

  app = Fastify({ logger: false });
  const requireSession = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers['x-test-user'] !== userId) {
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return { user: { id: userId } };
  };
  setupGalleryRoutes(app, requireSession);
  setupFolderRoutes(app, requireSession);
  setupPublicGalleryRoutes(app, requireSession);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.delete(assetDeletionLeases).where(eq(assetDeletionLeases.userId, userId));
  await db.delete(galleryItems).where(eq(galleryItems.userId, userId));
  await db.delete(jobs).where(eq(jobs.userId, userId));
  await db.delete(workflows).where(eq(workflows.userId, userId));
  await db.delete(usersPii).where(eq(usersPii.id, userId));
  await db.delete(usersApp).where(eq(usersApp.id, userId));
  await pool.end();
});

describe('soft-deleted gallery items across legacy and public surfaces', () => {
  it('hides immediately everywhere and reappears everywhere after restore', async () => {
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/assets/${itemId}`,
      headers: headers(),
    });
    expect(deleted.statusCode).toBe(200);

    const [list, folders, tags, bulk, showcase, publicItem] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/gallery', headers: headers() }),
      app.inject({ method: 'GET', url: '/v1/gallery/folders', headers: headers() }),
      app.inject({ method: 'GET', url: '/v1/gallery/tags', headers: headers() }),
      app.inject({
        method: 'POST',
        url: '/v1/gallery/bulk-download',
        headers: headers(),
        payload: { itemIds: [itemId] },
      }),
      app.inject({ method: 'GET', url: '/v1/showcase' }),
      app.inject({ method: 'GET', url: `/v1/g/${slug}` }),
    ]);
    const move = await app.inject({
      method: 'POST',
      url: '/v1/gallery/move',
      headers: headers(),
      payload: { itemIds: [itemId], folder: 'Скрыто' },
    });
    const tag = await app.inject({
      method: 'POST',
      url: '/v1/gallery/tag',
      headers: headers(),
      payload: { itemIds: [itemId], add: ['hidden'], remove: [] },
    });
    const publish = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      headers: headers(),
      payload: { itemId },
    });
    const unpublish = await app.inject({
      method: 'POST',
      url: '/v1/gallery/unpublish',
      headers: headers(),
      payload: { itemId },
    });

    expect.soft((list.json() as { rows: Array<{ id: string }> }).rows).toHaveLength(0);
    expect.soft(folders.json()).toEqual([]);
    expect.soft(tags.json()).toEqual([]);
    expect.soft(move.statusCode).toBe(404);
    expect.soft(tag.statusCode).toBe(404);
    expect.soft(bulk.statusCode).toBe(404);
    expect.soft(publish.statusCode).toBe(404);
    expect.soft(unpublish.statusCode).toBe(404);
    expect
      .soft(
        (showcase.json() as { items: Array<{ slug: string }> }).items.some(
          (item) => item.slug === slug,
        ),
      )
      .toBe(false);
    expect.soft(publicItem.statusCode).toBe(404);

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/assets/${itemId}/restore`,
      headers: headers(),
    });
    expect(restored.statusCode).toBe(200);

    const [restoredList, restoredShowcase, restoredPublic] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/gallery', headers: headers() }),
      app.inject({ method: 'GET', url: '/v1/showcase' }),
      app.inject({ method: 'GET', url: `/v1/g/${slug}` }),
    ]);
    expect((restoredList.json() as { rows: Array<{ id: string }> }).rows).toEqual([
      expect.objectContaining({ id: itemId }),
    ]);
    expect(
      (restoredShowcase.json() as { items: Array<{ slug: string }> }).items.some(
        (item) => item.slug === slug,
      ),
    ).toBe(true);
    expect(restoredPublic.statusCode).toBe(200);
  });

  it('hides expired media from owner lists, facets, mutations, and downloads', async () => {
    await db
      .update(galleryItems)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(galleryItems.id, itemId));

    try {
      const [list, folders, tags, bulk, move, tag] = await Promise.all([
        app.inject({ method: 'GET', url: '/v1/gallery', headers: headers() }),
        app.inject({ method: 'GET', url: '/v1/gallery/folders', headers: headers() }),
        app.inject({ method: 'GET', url: '/v1/gallery/tags', headers: headers() }),
        app.inject({
          method: 'POST',
          url: '/v1/gallery/bulk-download',
          headers: headers(),
          payload: { itemIds: [itemId] },
        }),
        app.inject({
          method: 'POST',
          url: '/v1/gallery/move',
          headers: headers(),
          payload: { itemIds: [itemId], folder: 'Не должно сохраниться' },
        }),
        app.inject({
          method: 'POST',
          url: '/v1/gallery/tag',
          headers: headers(),
          payload: { itemIds: [itemId], add: ['expired'], remove: [] },
        }),
      ]);

      expect((list.json() as { rows: Array<{ id: string }> }).rows).toHaveLength(0);
      expect(folders.json()).toEqual([]);
      expect(tags.json()).toEqual([]);
      expect(bulk.statusCode).toBe(404);
      expect(move.statusCode).toBe(404);
      expect(tag.statusCode).toBe(404);
    } finally {
      await db.update(galleryItems).set({ expiresAt: null }).where(eq(galleryItems.id, itemId));
    }
  });

  it('mixed legacy batches mutate only the live rows and report the true count', async () => {
    const deletedBatchId = nid();
    await db.insert(galleryItems).values({
      id: deletedBatchId,
      userId,
      jobId,
      assetUrl: `http://127.0.0.1:9000/seed-assets/${deletedBatchId}.png`,
      kind: 'image',
      folder: 'Исходная',
      tags: ['original'],
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/assets/${deletedBatchId}`,
      headers: headers(),
    });
    expect(deleted.statusCode).toBe(200);

    const move = await app.inject({
      method: 'POST',
      url: '/v1/gallery/move',
      headers: headers(),
      payload: { itemIds: [itemId, deletedBatchId], folder: 'Новая' },
    });
    const tag = await app.inject({
      method: 'POST',
      url: '/v1/gallery/tag',
      headers: headers(),
      payload: { itemIds: [itemId, deletedBatchId], add: ['new'], remove: [] },
    });
    expect.soft(move.statusCode).toBe(200);
    expect.soft(move.json()).toEqual({ ok: true, moved: 1 });
    expect.soft(tag.statusCode).toBe(200);
    expect.soft(tag.json()).toEqual({ ok: true, updated: 1 });

    const [liveRow] = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId));
    const [deletedRow] = await db
      .select()
      .from(galleryItems)
      .where(eq(galleryItems.id, deletedBatchId));
    expect.soft(liveRow?.folder).toBe('Новая');
    expect.soft(liveRow?.tags).toContain('new');
    expect.soft(deletedRow?.folder).toBe('Исходная');
    expect.soft(deletedRow?.tags).toEqual(['original']);
  });
});
