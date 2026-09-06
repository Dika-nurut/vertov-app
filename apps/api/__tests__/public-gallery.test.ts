import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { db, galleryItems, jobs, models, nid, pool, usersApp, usersPii, workflows } from '@seed/db';
import { setupPublicGalleryRoutes } from '../src/public-gallery';

const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'PublishTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `pub+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

async function makeItem(
  userId: string,
  options: {
    expiresAt?: Date;
    isPublic?: boolean;
    publicSlug?: string;
    featuredAt?: Date;
    presetSlug?: string | null;
    params?: Record<string, unknown>;
    referenceAssets?: string[];
  } = {},
): Promise<string> {
  const wId = nid();
  const jId = nid();
  await db.insert(workflows).values({
    id: wId,
    userId,
    modelId: 'seedream-4-5',
    params: options.params ?? { prompt: 'тестовый промт' },
    referenceAssets: options.referenceAssets ?? [],
  });
  await db.insert(jobs).values({
    id: jId,
    userId,
    workflowId: wId,
    modelId: 'seedream-4-5',
    status: 'succeeded',
    creditsReserved: 15,
    presetSlug: options.presetSlug,
    idempotencyKey: `pub-${jId}`,
    resultAssets: ['http://127.0.0.1:9000/seed-assets/x.png'],
  });
  const iId = nid();
  await db.insert(galleryItems).values({
    id: iId,
    userId,
    jobId: jId,
    assetUrl: 'http://127.0.0.1:9000/seed-assets/x.png',
    kind: 'image',
    tags: [],
    expiresAt: options.expiresAt,
    isPublic: options.isPublic,
    publicSlug: options.publicSlug,
    featuredAt: options.featuredAt,
  });
  return iId;
}

let userId: string;
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  userId = await makeUser();
  app = Fastify({ logger: false });
  setupPublicGalleryRoutes(app, async () => ({ user: { id: userId } }));
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  for (const id of createdUsers) {
    await db.delete(galleryItems).where(eq(galleryItems.userId, id));
    await db.delete(jobs).where(eq(jobs.userId, id));
    await db.delete(workflows).where(eq(workflows.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  await pool.end();
});

describe('public gallery: publish / unpublish / GET by slug', () => {
  let itemId: string;
  beforeEach(async () => {
    itemId = await makeItem(userId);
  });
  afterEach(async () => {
    await db.delete(galleryItems).where(eq(galleryItems.id, itemId));
  });

  it('publish mints a slug and flips isPublic', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; slug: string };
    expect(body.slug).toMatch(/^[a-zA-Z0-9]{12}$/);
    const row = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId));
    expect(row[0]!.isPublic).toBe(true);
    expect(row[0]!.publicSlug).toBe(body.slug);
  });

  it('GET /v1/g/:slug returns 200 for public + 404 for private', async () => {
    const pub = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId },
    });
    const slug = (pub.json() as { slug: string }).slug;
    const ok = await app.inject({ method: 'GET', url: `/v1/g/${slug}` });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      prompt: string;
      displayName: string;
      modelDisplayName: string | null;
      presetSlug: string | null;
    };
    expect(body.prompt).toBe('тестовый промт');
    expect(body.displayName).toBe('PublishTest');
    expect(body.presetSlug).toBeNull();
    const model = await db
      .select({ displayName: models.displayName })
      .from(models)
      .where(eq(models.id, 'seedream-4-5'));
    expect(body.modelDisplayName).toBe(model[0]!.displayName);

    // Unpublish → same slug now 404.
    await app.inject({ method: 'POST', url: '/v1/gallery/unpublish', payload: { itemId } });
    const gone = await app.inject({ method: 'GET', url: `/v1/g/${slug}` });
    expect(gone.statusCode).toBe(404);
  });

  it('GET /v1/g/:slug projects job preset provenance', async () => {
    const presetItem = await makeItem(userId, { presetSlug: 'vitrina-noir' });
    const pub = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId: presetItem },
    });
    const slug = (pub.json() as { slug: string }).slug;

    const res = await app.inject({ method: 'GET', url: `/v1/g/${slug}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { presetSlug: string | null }).presetSlug).toBe('vitrina-noir');

    await db.delete(galleryItems).where(eq(galleryItems.id, presetItem));
  });

  it('GET /v1/g/:slug/prefill returns the public remix recipe', async () => {
    const refs = ['http://127.0.0.1:9000/seed-assets/ref1.png'];
    const remixItem = await makeItem(userId, {
      presetSlug: 'vitrina-noir',
      params: {
        prompt: 'рецепт',
        size: '1:1',
        n: 2,
        seed: 7,
        aspect_ratio: '1:1',
        imageUrls: refs,
        secret: 'must-not-leak',
      },
      referenceAssets: refs,
    });
    const pub = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId: remixItem },
    });
    const slug = (pub.json() as { slug: string }).slug;

    const res = await app.inject({ method: 'GET', url: `/v1/g/${slug}/prefill` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      modelId: string;
      presetSlug: string | null;
      params: Record<string, unknown>;
      referenceAssets: string[];
    };
    expect(body.modelId).toBe('seedream-4-5');
    expect(body.presetSlug).toBe('vitrina-noir');
    expect(body.params['prompt']).toBe('рецепт');
    expect(body.params['n']).toBe(2);
    expect(body.params['secret']).toBeUndefined();
    expect(body.referenceAssets).toEqual(refs);

    await db.delete(galleryItems).where(eq(galleryItems.id, remixItem));
  });

  it('GET /v1/g/:slug/prefill 404s for private and missing items', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/g/does-not-exist/prefill' })).statusCode,
    ).toBe(404);

    const privItem = await makeItem(userId, { isPublic: false });
    const priv = await app.inject({
      method: 'GET',
      url: '/v1/g/never-published/prefill',
    });
    expect(priv.statusCode).toBe(404);
    await db.delete(galleryItems).where(eq(galleryItems.id, privItem));
  });

  it('GET /v1/g/:missing returns 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/g/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('republish reuses the slug', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId },
    });
    const slug1 = (a.json() as { slug: string }).slug;
    await app.inject({ method: 'POST', url: '/v1/gallery/unpublish', payload: { itemId } });
    const b = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId },
    });
    const slug2 = (b.json() as { slug: string }).slug;
    expect(slug2).toBe(slug1);
  });

  it('publish on a different-owner item returns 404', async () => {
    const otherUser = await makeUser();
    const otherItem = await makeItem(otherUser);
    // Adapter is closed over userId (not otherUser), so this should 404
    // because the WHERE clause checks owner.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId: otherItem },
    });
    expect(res.statusCode).toBe(404);
  });

  it('H2: publish refuses an nsfw-tagged item (403)', async () => {
    await db
      .update(galleryItems)
      .set({ tags: ['nsfw'] })
      .where(eq(galleryItems.id, itemId));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('nsfw_blocked');
  });

  it('H2: a published item later tagged nsfw is 404 on its slug (defense-in-depth)', async () => {
    const pub = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId },
    });
    const slug = (pub.json() as { slug: string }).slug;
    await db
      .update(galleryItems)
      .set({ featuredAt: new Date() })
      .where(eq(galleryItems.id, itemId));
    await db
      .update(galleryItems)
      .set({ tags: ['nsfw'] })
      .where(eq(galleryItems.id, itemId));
    const gone = await app.inject({ method: 'GET', url: `/v1/g/${slug}` });
    expect(gone.statusCode).toBe(404);
    const showcase = await app.inject({ method: 'GET', url: '/v1/showcase' });
    expect(
      (showcase.json() as { items: Array<{ slug: string | null }> }).items.some(
        (item) => item.slug === slug,
      ),
    ).toBe(false);
  });

  it('retention expiry blocks publishing and hides already-public links/feed rows', async () => {
    const expiredSlug = `expired-${nid()}`;
    await db
      .update(galleryItems)
      .set({
        isPublic: true,
        publicSlug: expiredSlug,
        featuredAt: new Date(),
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(galleryItems.id, itemId));

    const republish = await app.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId },
    });
    expect(republish.statusCode).toBe(404);

    const publicItem = await app.inject({ method: 'GET', url: `/v1/g/${expiredSlug}` });
    expect(publicItem.statusCode).toBe(404);

    const showcase = await app.inject({ method: 'GET', url: '/v1/showcase' });
    expect(
      (showcase.json() as { items: Array<{ slug: string | null }> }).items.some(
        (item) => item.slug === expiredSlug,
      ),
    ).toBe(false);
  });
});

describe('SF-13: /v1/showcase is cacheable', () => {
  it('sets a public cache-control so the edge/browser can cache the feed', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/showcase' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
  });
});
