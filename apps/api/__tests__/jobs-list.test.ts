import 'dotenv/config';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, galleryItems, jobs, models, nid, pool, usersApp, usersPii, workflows } from '@seed/db';
import { countActiveJobsForUser, getJobForUser, listJobsForUser } from '../src/jobs-list';

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'JobsListTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `jobslist+${id}@seed.local` });
  return id;
}

async function pickModelId(): Promise<string> {
  const rows = await db.select({ id: models.id }).from(models).limit(1);
  if (!rows[0]) throw new Error('seed must run first — no models available');
  return rows[0].id;
}

interface InsertOpts {
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'refunded';
  queuedAt?: Date;
  resultAssets?: string[];
}

async function insertJob(userId: string, modelId: string, opts: InsertOpts = {}): Promise<string> {
  const workflowId = nid();
  const jobId = nid();
  await db.insert(workflows).values({
    id: workflowId,
    userId,
    modelId,
    params: { prompt: 'test', size: '1024x1024' },
    referenceAssets: [],
  });
  await db.insert(jobs).values({
    id: jobId,
    userId,
    workflowId,
    modelId,
    status: opts.status ?? 'succeeded',
    creditsReserved: 15,
    creditsSpent: opts.status === 'succeeded' ? 15 : 0,
    resultAssets: opts.resultAssets ?? [`http://example/${jobId}.png`],
    idempotencyKey: `jobs-list-test:${jobId}`,
    queuedAt: opts.queuedAt ?? new Date(),
  });
  return jobId;
}

const createdUsers: string[] = [];
const createdModels: string[] = [];

beforeEach(() => {
  createdUsers.length = 0;
  createdModels.length = 0;
});

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(galleryItems).where(eq(galleryItems.userId, id));
    await db.delete(jobs).where(eq(jobs.userId, id));
    await db.delete(workflows).where(eq(workflows.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  for (const id of createdModels) {
    await db.delete(models).where(eq(models.id, id));
  }
});

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const id = await makeUser();
  createdUsers.push(id);
  return id;
}

describe('listJobsForUser', () => {
  it('empty user returns no rows', async () => {
    const u = await newUser();
    const page = await listJobsForUser(u, { limit: 24 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns owner-scoped rows newest-first', async () => {
    const u1 = await newUser();
    const u2 = await newUser();
    const modelId = await pickModelId();

    // Distinct queuedAt timestamps so ordering is unambiguous.
    const t0 = new Date(Date.now() - 3_000);
    const t1 = new Date(Date.now() - 2_000);
    const t2 = new Date(Date.now() - 1_000);
    const j1 = await insertJob(u1, modelId, { queuedAt: t0 });
    const j2 = await insertJob(u1, modelId, { queuedAt: t1 });
    const j3 = await insertJob(u1, modelId, { queuedAt: t2 });
    // Other user — must not leak into u1's page.
    await insertJob(u2, modelId, { queuedAt: t2 });

    const page = await listJobsForUser(u1, { limit: 24 });
    expect(page.rows.map((r) => r.id)).toEqual([j3, j2, j1]);
    expect(page.nextCursor).toBeNull();
  });

  it('paginates via composite cursor without skips or duplicates', async () => {
    const u = await newUser();
    const modelId = await pickModelId();
    const ids: string[] = [];
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      ids.push(await insertJob(u, modelId, { queuedAt: new Date(base - i * 1000) }));
    }
    // Inserted newest = ids[0], oldest = ids[4].
    const page1 = await listJobsForUser(u, { limit: 2 });
    expect(page1.rows.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listJobsForUser(u, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.rows.map((r) => r.id)).toEqual([ids[2], ids[3]]);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listJobsForUser(u, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.rows.map((r) => r.id)).toEqual([ids[4]]);
    expect(page3.nextCursor).toBeNull();
  });

  it('breaks ties on identical timestamps via id ordering', async () => {
    const u = await newUser();
    const modelId = await pickModelId();
    const sameTime = new Date();
    const a = await insertJob(u, modelId, { queuedAt: sameTime });
    const b = await insertJob(u, modelId, { queuedAt: sameTime });
    const c = await insertJob(u, modelId, { queuedAt: sameTime });
    const all = [a, b, c].sort().reverse(); // DESC by id

    const page1 = await listJobsForUser(u, { limit: 2 });
    expect(page1.rows.map((r) => r.id)).toEqual([all[0], all[1]]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listJobsForUser(u, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.rows.map((r) => r.id)).toEqual([all[2]]);
  });

  it('filters by status', async () => {
    const u = await newUser();
    const modelId = await pickModelId();
    await insertJob(u, modelId, { status: 'succeeded' });
    await insertJob(u, modelId, { status: 'failed' });
    await insertJob(u, modelId, { status: 'failed' });

    const ok = await listJobsForUser(u, { limit: 24, status: 'succeeded' });
    expect(ok.rows).toHaveLength(1);
    const failed = await listJobsForUser(u, { limit: 24, status: 'failed' });
    expect(failed.rows).toHaveLength(2);
  });

  it('does not enrich job history with a soft-deleted gallery item', async () => {
    const userId = await newUser();
    const modelId = await pickModelId();
    const jobId = await insertJob(userId, modelId);
    const itemId = nid();
    await db.insert(galleryItems).values({
      id: itemId,
      userId,
      jobId,
      assetUrl: `https://assets.seed.test/${itemId}.png`,
      kind: 'image',
      isPublic: true,
      publicSlug: `deleted-${itemId}`,
      deletedAt: new Date(),
    });

    const detail = await getJobForUser(jobId, userId);
    expect(detail?.galleryItem).toBeNull();
  });

  it('keeps the job receipt but strips expired result URLs', async () => {
    const userId = await newUser();
    const modelId = await pickModelId();
    const liveUrl = `https://assets.seed.test/${userId}-live.png`;
    const expiredUrl = `https://assets.seed.test/${userId}-expired.png`;
    const jobId = await insertJob(userId, modelId, { resultAssets: [liveUrl, expiredUrl] });
    const liveAssetId = nid();
    const expiredAssetId = nid();
    await db.insert(galleryItems).values([
      {
        id: liveAssetId,
        userId,
        jobId,
        assetUrl: liveUrl,
        kind: 'image',
      },
      {
        id: expiredAssetId,
        userId,
        jobId,
        assetUrl: expiredUrl,
        kind: 'image',
        expiresAt: new Date(Date.now() - 1_000),
      },
    ]);

    const listed = await listJobsForUser(userId);
    expect(listed.rows.find((row) => row.id === jobId)?.resultAssets).toEqual([liveUrl]);
    const detail = await getJobForUser(jobId, userId);
    expect(detail?.resultAssets).toEqual([liveUrl]);
    expect(detail?.galleryItem).toMatchObject({ id: liveAssetId });

    await db
      .update(galleryItems)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(galleryItems.id, liveAssetId));
    const expiredDetail = await getJobForUser(jobId, userId);
    expect(expiredDetail?.resultAssets).toEqual([]);
    expect(expiredDetail?.galleryItem).toBeNull();
  });

  it('returns inactive model metadata to its owner without exposing it to another user', async () => {
    const owner = await newUser();
    const otherUser = await newUser();
    const modelId = `archived-video-${nid()}`;
    createdModels.push(modelId);
    await db.insert(models).values({
      id: modelId,
      provider: 'byteplus',
      family: 'Archive Studio',
      variant: '9-reference',
      displayName: 'Archived Orchid',
      kind: 'video',
      isActive: false,
      tierMin: 'free',
      unitKind: 'second',
      expectedLatencyMsP50: 1_000,
      expectedLatencyMsP95: 2_000,
      providerModelId: 'archive/orchid',
      providerEndpoint: '/videos',
      capabilities: { reference: true },
    });
    const jobId = await insertJob(owner, modelId);

    const detail = await getJobForUser(jobId, owner);
    expect(detail?.model).toEqual({
      family: 'Archive Studio',
      variant: '9-reference',
      displayName: 'Archived Orchid',
      kind: 'video',
      capabilities: { reference: true },
    });
    expect(await getJobForUser(jobId, otherUser)).toBeNull();
  });
});

/**
 * SF-11 — per-user in-flight job concurrency cap. `countActiveJobsForUser`
 * counts only queued|running jobs (not terminal ones) and is owner-scoped; the
 * `/v1/jobs` submit path uses it to refuse a user holding too many reserved
 * jobs at once. Pre-fix there was no such count or cap.
 */
describe('SF-11: countActiveJobsForUser', () => {
  it('counts only queued|running jobs, owner-scoped', async () => {
    const u = await newUser();
    const other = await newUser();
    const modelId = await pickModelId();
    await insertJob(u, modelId, { status: 'queued' });
    await insertJob(u, modelId, { status: 'running' });
    await insertJob(u, modelId, { status: 'queued' });
    await insertJob(u, modelId, { status: 'succeeded' }); // not in-flight
    await insertJob(u, modelId, { status: 'failed' }); // not in-flight
    await insertJob(other, modelId, { status: 'running' }); // other user

    expect(await countActiveJobsForUser(u, 8)).toBe(3);
    expect(await countActiveJobsForUser(other, 8)).toBe(1);
  });

  it('stops counting at cap + 1 (enough to know the cap is reached)', async () => {
    const u = await newUser();
    const modelId = await pickModelId();
    for (let i = 0; i < 5; i++) await insertJob(u, modelId, { status: 'queued' });
    // cap 2 → the helper fetches at most 3 rows; the handler rejects on >= cap.
    expect(await countActiveJobsForUser(u, 2)).toBe(3);
    expect(await countActiveJobsForUser(u, 2)).toBeGreaterThanOrEqual(2);
  });
});
