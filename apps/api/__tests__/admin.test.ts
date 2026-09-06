import 'dotenv/config';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { and, eq } from 'drizzle-orm';
import { auditLog, db, galleryItems, jobs, nid, pool, usersApp, workflows } from '@seed/db';
import { setupAdminRoutes, setupReportRoutes } from '../src/admin';
import { setupPublicGalleryRoutes } from '../src/public-gallery';

const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'AdminTest', locale: 'ru' });
  createdUsers.push(id);
  return id;
}

async function makePublishedItem(userId: string): Promise<string> {
  const wId = nid();
  const jId = nid();
  await db.insert(workflows).values({
    id: wId,
    userId,
    modelId: 'seedream-4-5',
    params: { prompt: 'x' },
    referenceAssets: [],
  });
  await db.insert(jobs).values({
    id: jId,
    userId,
    workflowId: wId,
    modelId: 'seedream-4-5',
    status: 'succeeded',
    creditsReserved: 15,
    idempotencyKey: `adm-${jId}`,
  });
  const iId = nid();
  await db.insert(galleryItems).values({
    id: iId,
    userId,
    jobId: jId,
    assetUrl: 'http://127.0.0.1:9000/seed-assets/x.png',
    kind: 'image',
    tags: [],
    isPublic: true,
    publicSlug: nid(),
    featuredAt: new Date(),
  });
  return iId;
}

function appFor(userId: string): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  setupAdminRoutes(app, async () => ({ user: { id: userId } }));
  return app;
}

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(auditLog).where(eq(auditLog.userId, id));
    await db.delete(galleryItems).where(eq(galleryItems.userId, id));
    await db.delete(jobs).where(eq(jobs.userId, id));
    await db.delete(workflows).where(eq(workflows.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  createdUsers.length = 0;
  delete process.env.ADMIN_USER_IDS;
});
afterAll(async () => {
  await pool.end();
});

describe('M7: admin gallery takedown', () => {
  it('non-admin is forbidden (403) and the item stays public', async () => {
    const owner = await makeUser();
    const nonAdmin = await makeUser();
    const itemId = await makePublishedItem(owner);
    process.env.ADMIN_USER_IDS = ''; // nobody is admin

    const app = appFor(nonAdmin);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/gallery/takedown',
      payload: { itemId },
    });
    expect(res.statusCode).toBe(403);
    const row = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId)).limit(1);
    expect(row[0]!.isPublic).toBe(true); // untouched
    await app.close();
  });

  it("admin takes down ANOTHER user's item from both surfaces + writes an audit row", async () => {
    const owner = await makeUser();
    const admin = await makeUser();
    const itemId = await makePublishedItem(owner);
    process.env.ADMIN_USER_IDS = `someone-else,${admin}`;

    const app = appFor(admin);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/gallery/takedown',
      payload: { itemId, reason: 'abuse report #42' },
    });
    expect(res.statusCode).toBe(200);

    const row = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId)).limit(1);
    expect(row[0]!.isPublic).toBe(false); // pulled from /g/:slug
    expect(row[0]!.featuredAt).toBeNull(); // pulled from /showcase

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'gallery.takedown')));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.payload as { ownerId: string }).ownerId).toBe(owner);
    expect((audit[0]!.payload as { reason: string }).reason).toBe('abuse report #42');
    await app.close();
  });

  it('makes takedown durable so the owner cannot republish the blocked item', async () => {
    const owner = await makeUser();
    const admin = await makeUser();
    const itemId = await makePublishedItem(owner);
    process.env.ADMIN_USER_IDS = admin;

    const adminApp = appFor(admin);
    await adminApp.ready();
    const taken = await adminApp.inject({
      method: 'POST',
      url: '/v1/admin/gallery/takedown',
      payload: { itemId, reason: 'durable moderation regression' },
    });
    expect(taken.statusCode).toBe(200);
    await adminApp.close();

    const ownerApp = Fastify({ logger: false });
    setupPublicGalleryRoutes(ownerApp, async () => ({ user: { id: owner } }));
    await ownerApp.ready();
    const republish = await ownerApp.inject({
      method: 'POST',
      url: '/v1/gallery/publish',
      payload: { itemId },
    });
    expect(republish.statusCode).toBe(404);
    const row = await db.select().from(galleryItems).where(eq(galleryItems.id, itemId)).limit(1);
    expect(row[0]!.moderationTakedownAt).toBeInstanceOf(Date);
    expect(row[0]!.isPublic).toBe(false);
    await ownerApp.close();
  });

  it('returns 404 for a missing item', async () => {
    const admin = await makeUser();
    process.env.ADMIN_USER_IDS = admin;
    const app = appFor(admin);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/gallery/takedown',
      payload: { itemId: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('M7: public content report intake', () => {
  function reportApp(): ReturnType<typeof Fastify> {
    const app = Fastify({ logger: false });
    setupReportRoutes(app);
    return app;
  }

  it('records a public report to the audit log', async () => {
    const marker = `report-${nid()}`;
    const app = reportApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/report',
      payload: { slug: marker, reason: 'NSFW under the brand', category: 'nsfw' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'content.report'));
    const mine = rows.find((r) => (r.payload as { slug?: string }).slug === marker);
    expect(mine).toBeTruthy();
    expect((mine!.payload as { category: string }).category).toBe('nsfw');
    await db.delete(auditLog).where(eq(auditLog.id, mine!.id));
    await app.close();
  });

  it('rejects a report with neither itemId nor slug (400)', async () => {
    const app = reportApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/report',
      payload: { reason: 'no target given' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
