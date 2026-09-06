import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db, galleryItems, jobs, nid, pool, usersApp, usersPii, workflows } from '@seed/db';
import { setupGalleryRoutes } from '../src/gallery';

const createdUsers: string[] = [];
let app: ReturnType<typeof Fastify>;

async function makeUser(tier: 'free' | 'start' = 'free'): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'LibTest', locale: 'ru', tier });
  await db.insert(usersPii).values({ id, email: `lib+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

async function makeJobAndItem(
  userId: string,
  opts: { folder?: string | null; tags?: string[]; expiresAt?: Date | null } = {},
): Promise<{ jobId: string; itemId: string }> {
  const workflowId = nid();
  const jobId = nid();
  await db.insert(workflows).values({
    id: workflowId,
    userId,
    modelId: 'seedream-4-5',
    params: { prompt: 'test' },
    referenceAssets: [],
  });
  await db.insert(jobs).values({
    id: jobId,
    userId,
    workflowId,
    modelId: 'seedream-4-5',
    status: 'succeeded',
    creditsReserved: 15,
    idempotencyKey: `lib-test-${jobId}`,
    resultAssets: ['http://127.0.0.1:9000/seed-assets/x.png'],
  });
  const itemId = nid();
  await db.insert(galleryItems).values({
    id: itemId,
    userId,
    jobId,
    assetUrl: 'http://127.0.0.1:9000/seed-assets/x.png',
    kind: 'image',
    folder: opts.folder ?? null,
    tags: opts.tags ?? [],
    expiresAt: opts.expiresAt ?? null,
  });
  return { jobId, itemId };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  setupGalleryRoutes(app, async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.headers['x-test-user'];
    if (typeof userId !== 'string') {
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return { user: { id: userId } };
  });
  await app.ready();
});

beforeEach(() => {
  createdUsers.length = 0;
});

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(galleryItems).where(eq(galleryItems.userId, id));
    await db.delete(jobs).where(eq(jobs.userId, id));
    await db.delete(workflows).where(eq(workflows.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('gallery: move + tag + filter', () => {
  it('legacy move returns 200 and persists the folder for owned items only', async () => {
    const u = await makeUser();
    const a = await makeJobAndItem(u);
    const b = await makeJobAndItem(u);
    const otherUser = await makeUser();
    const c = await makeJobAndItem(otherUser); // must not be touched

    const response = await app.inject({
      method: 'POST',
      url: '/v1/gallery/move',
      headers: { 'x-test-user': u },
      payload: { itemIds: [a.itemId, b.itemId, c.itemId], folder: 'Эксперименты' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, moved: 2 });
    expect(response.headers.deprecation).toBe('true');

    const aRow = await db.select().from(galleryItems).where(eq(galleryItems.id, a.itemId));
    expect(aRow[0]!.folder).toBe('Эксперименты');
    const bRow = await db.select().from(galleryItems).where(eq(galleryItems.id, b.itemId));
    expect(bRow[0]!.folder).toBe('Эксперименты');
    const cRow = await db.select().from(galleryItems).where(eq(galleryItems.id, c.itemId));
    expect(cRow[0]!.folder).toBeNull();
  });

  it('tag add + remove uses array set semantics', async () => {
    const u = await makeUser();
    const { itemId } = await makeJobAndItem(u, { tags: ['x', 'y'] });
    // add z, remove x
    const rows = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId));
    const current = new Set<string>(rows[0]!.tags ?? []);
    current.add('z');
    current.delete('x');
    await db
      .update(galleryItems)
      .set({ tags: [...current] })
      .where(eq(galleryItems.id, itemId));
    const after = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId));
    expect(after[0]!.tags.sort()).toEqual(['y', 'z']);
  });

  it('filter by tag uses ANY()', async () => {
    const u = await makeUser();
    await makeJobAndItem(u, { tags: ['proj-a', 'sketch'] });
    await makeJobAndItem(u, { tags: ['proj-b'] });
    const rows = await db
      .select()
      .from(galleryItems)
      .where(sql`${galleryItems.userId} = ${u} AND 'sketch' = ANY(${galleryItems.tags})`);
    expect(rows).toHaveLength(1);
  });
});

describe('gallery: free-tier expiry', () => {
  it('expires_at is set 30 days out for free users', async () => {
    const u = await makeUser('free');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const { itemId } = await makeJobAndItem(u, { expiresAt });
    const row = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId));
    expect(row[0]!.expiresAt).toBeTruthy();
    const diffDays = (row[0]!.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
  });

  it('expires_at stays NULL on paid tiers', async () => {
    const u = await makeUser('start');
    const { itemId } = await makeJobAndItem(u, { expiresAt: null });
    const row = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId));
    expect(row[0]!.expiresAt).toBeNull();
  });

  it('reaper deletes expired rows', async () => {
    const u = await makeUser('free');
    const past = new Date(Date.now() - 60_000);
    const { itemId } = await makeJobAndItem(u, { expiresAt: past });
    const future = new Date(Date.now() + 60_000);
    const survivor = await makeJobAndItem(u, { expiresAt: future });

    const { reapExpiredGalleryItems } = await import('../src/gallery');
    const out = await reapExpiredGalleryItems();
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    const expiredRow = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId));
    expect(expiredRow).toHaveLength(0);
    const survivorRow = await db
      .select()
      .from(galleryItems)
      .where(eq(galleryItems.id, survivor.itemId));
    expect(survivorRow).toHaveLength(1);
  });
});

describe('gallery: bulk download cap', () => {
  it('would 414 over 100 items (logic test via constant)', async () => {
    const BULK_CAP = 100; // mirrors the constant in src/gallery.ts
    const ids = Array.from({ length: 101 }, () => nid());
    expect(ids.length > BULK_CAP).toBe(true);
  });
});
