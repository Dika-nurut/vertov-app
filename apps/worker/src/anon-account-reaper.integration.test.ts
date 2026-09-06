import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq, inArray, like } from 'drizzle-orm';
import {
  assetPlacements,
  assetReferences,
  boards,
  db,
  folders,
  galleryItems,
  nid,
  orders,
  pool,
  projectAssets,
  projects,
  user,
  usersApp,
} from '@seed/db';
import { sweepAbandonedAnonAccounts } from './anon-account-reaper';
import type { AssetStorage } from './storage';
import { cleanupIntegrationData } from './test-support/seed';

/**
 * Pre-paywall anonymous browsing mints a real `user` (isAnonymous=true) +
 * `users_app` row on first touch. Most visitors never come back to claim it
 * (packages/auth's claimAnonymousWork). This reaper is the only thing that
 * ever deletes real user identities + cascades their content — the highest-
 * stakes test in this file is "never touches a real account."
 */
const log = pino({ level: 'silent' });
const PREFIX = 'it-anonreap-';
const tag = (label: string) => `${PREFIX}${label}-${nid()}`;
const noOpStorage = {
  listKeys: async () => [],
  removeObjects: async () => {},
} as unknown as Pick<AssetStorage, 'listKeys' | 'removeObjects'>;
const sweep = (ttlMs: number, storage = noOpStorage) =>
  sweepAbandonedAnonAccounts(log, ttlMs, storage);

async function seedAuthUser(opts: {
  isAnonymous: boolean;
  ageMs: number;
  email?: string;
}): Promise<string> {
  const id = tag('user');
  await db.insert(user).values({
    id,
    name: opts.isAnonymous ? 'Anonymous' : 'Real User',
    email: opts.email ?? `${id}@example.com`,
    isAnonymous: opts.isAnonymous,
    createdAt: new Date(Date.now() - opts.ageMs),
  });
  return id;
}

async function seedAppUser(id: string, status: 'active' | 'deleted' = 'active'): Promise<void> {
  await db.insert(usersApp).values({ id, tier: 'free', status });
}

async function cleanupAuthUsers(): Promise<void> {
  await db.delete(user).where(like(user.id, `${PREFIX}%`));
}

async function cleanupSredaFixtures(): Promise<void> {
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
}

beforeAll(async () => {
  await cleanupSredaFixtures();
  await cleanupIntegrationData();
  await cleanupAuthUsers();
});

afterEach(async () => {
  await cleanupSredaFixtures();
  await cleanupIntegrationData();
  await cleanupAuthUsers();
});

afterAll(async () => {
  await pool.end();
});

describe('anon-account-reaper — abandoned anonymous account sweep', () => {
  it('reaps a never-claimed anonymous account past the TTL, cascading its content', async () => {
    const id = await seedAuthUser({ isAnonymous: true, ageMs: 10 * 24 * 60 * 60 * 1000 }); // 10d old
    await seedAppUser(id);
    const boardId = tag('board');
    await db.insert(boards).values({ id: boardId, userId: id, title: 'Т' });

    const result = await sweep(7 * 24 * 60 * 60 * 1000); // 7d TTL
    expect(result.neverClaimed).toBeGreaterThanOrEqual(1);

    const [userRow] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    const [appRow] = await db.select().from(usersApp).where(eq(usersApp.id, id)).limit(1);
    const [boardRow] = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1);
    expect(userRow).toBeUndefined();
    expect(appRow).toBeUndefined();
    expect(boardRow).toBeUndefined(); // cascaded via users_app FK
  });

  it('retains anonymous rows when raw-object cleanup fails, then retries before deletion', async () => {
    const id = await seedAuthUser({ isAnonymous: true, ageMs: 10 * 24 * 60 * 60 * 1000 });
    await seedAppUser(id);
    const prefixes: string[] = [];
    const removed: string[] = [];
    let attempts = 0;
    const storage = {
      listKeys: async (prefix: string) => {
        prefixes.push(prefix);
        return prefix === `${id}/`
          ? [`${id}/video/source.mp4`, `${id}/video/source.mp4.peaks.json`]
          : [`_mp/${id}/upload/0`];
      },
      removeObjects: async (keys: string[]) => {
        attempts += 1;
        if (attempts <= 2) throw new Error('temporary object-store outage');
        removed.push(...keys);
      },
    } as unknown as Pick<AssetStorage, 'listKeys' | 'removeObjects'>;

    await expect(sweep(7 * 24 * 60 * 60 * 1000, storage)).resolves.toMatchObject({
      neverClaimed: 0,
    });
    expect(await db.select().from(user).where(eq(user.id, id))).toHaveLength(1);
    expect(await db.select().from(usersApp).where(eq(usersApp.id, id))).toHaveLength(1);

    await expect(sweep(7 * 24 * 60 * 60 * 1000, storage)).resolves.toMatchObject({
      neverClaimed: 1,
    });
    expect(await db.select().from(user).where(eq(user.id, id))).toHaveLength(0);
    expect(await db.select().from(usersApp).where(eq(usersApp.id, id))).toHaveLength(0);
    expect(prefixes).toEqual([`${id}/`, `_mp/${id}/`, `${id}/`, `_mp/${id}/`]);
    expect(attempts).toBe(4);
    expect(removed).toEqual([
      `${id}/video/source.mp4`,
      `${id}/video/source.mp4.peaks.json`,
      `_mp/${id}/upload/0`,
    ]);
  });

  it('reaps an anonymous account whose project asset is placed and keep-referenced', async () => {
    const id = await seedAuthUser({ isAnonymous: true, ageMs: 10 * 24 * 60 * 60 * 1000 });
    await seedAppUser(id);
    const projectId = tag('project');
    const folderId = tag('folder');
    const assetId = tag('asset');
    const referenceId = tag('reference');
    await db.insert(projects).values({ id: projectId, userId: id, title: 'Архив' });
    await db.insert(folders).values({ id: folderId, projectId, userId: id, name: 'Отбор' });
    await db.insert(galleryItems).values({
      id: assetId,
      userId: id,
      originProjectId: projectId,
      assetUrl: `http://127.0.0.1:9000/seed-assets/${assetId}.png`,
      kind: 'image',
      sourceKind: 'upload',
    });
    await db.insert(projectAssets).values({ projectId, assetId, userId: id });
    await db.insert(assetPlacements).values({ assetId, folderId });
    await db.insert(assetReferences).values({
      id: referenceId,
      galleryItemId: assetId,
      userId: id,
      refType: 'keep',
      refId: folderId,
    });

    await sweep(7 * 24 * 60 * 60 * 1000);

    expect(await db.select().from(user).where(eq(user.id, id))).toHaveLength(0);
    expect(await db.select().from(usersApp).where(eq(usersApp.id, id))).toHaveLength(0);
    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toHaveLength(0);
    expect(await db.select().from(folders).where(eq(folders.id, folderId))).toHaveLength(0);
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(assetReferences).where(eq(assetReferences.galleryItemId, assetId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId)),
    ).toHaveLength(0);
    expect(await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))).toHaveLength(
      0,
    );
  });

  it('does NOT reap an anonymous account still inside the TTL window', async () => {
    const id = await seedAuthUser({ isAnonymous: true, ageMs: 60 * 60 * 1000 }); // 1h old
    await seedAppUser(id);

    await sweep(7 * 24 * 60 * 60 * 1000);

    const [userRow] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    expect(userRow).toBeDefined();
  });

  it('NEVER reaps a real (non-anonymous) account, no matter how old', async () => {
    const id = await seedAuthUser({ isAnonymous: false, ageMs: 365 * 24 * 60 * 60 * 1000 }); // 1y old
    await seedAppUser(id);

    await sweep(7 * 24 * 60 * 60 * 1000);

    const [userRow] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    const [appRow] = await db.select().from(usersApp).where(eq(usersApp.id, id)).limit(1);
    expect(userRow).toBeDefined();
    expect(appRow).toBeDefined();
  });

  it('reaps an orphaned users_app row (claimed anon leftover) with no matching user row, regardless of age', async () => {
    const id = tag('orphan');
    await seedAppUser(id); // users_app row, but deliberately NO matching `user` row
    const projectId = tag('project');
    const folderId = tag('folder');
    const assetId = tag('asset');
    await db.insert(projects).values({ id: projectId, userId: id, title: 'Сирота' });
    await db.insert(folders).values({ id: folderId, projectId, userId: id, name: 'Отбор' });
    await db.insert(galleryItems).values({
      id: assetId,
      userId: id,
      originProjectId: projectId,
      assetUrl: `http://127.0.0.1:9000/seed-assets/${assetId}.png`,
      kind: 'image',
      sourceKind: 'upload',
    });
    await db.insert(projectAssets).values({ projectId, assetId, userId: id });
    await db.insert(assetPlacements).values({ assetId, folderId });

    const removed: string[] = [];
    const storage = {
      listKeys: async (prefix: string) =>
        prefix === `${id}/` ? [`${id}/orphan/source.mp4`] : [`_mp/${id}/upload/0`],
      removeObjects: async (keys: string[]) => {
        removed.push(...keys);
      },
    } as unknown as Pick<AssetStorage, 'listKeys' | 'removeObjects'>;
    const result = await sweep(7 * 24 * 60 * 60 * 1000, storage);
    expect(result.orphaned).toBeGreaterThanOrEqual(1);
    expect(removed).toEqual([`${id}/orphan/source.mp4`, `_mp/${id}/upload/0`]);

    const [appRow] = await db.select().from(usersApp).where(eq(usersApp.id, id)).limit(1);
    expect(appRow).toBeUndefined();
    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toHaveLength(0);
    expect(await db.select().from(folders).where(eq(folders.id, folderId))).toHaveLength(0);
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId)),
    ).toHaveLength(0);
    expect(await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))).toHaveLength(
      0,
    );
  });

  it('does NOT treat a soft-deleted real account as orphaned (its user row still exists)', async () => {
    const id = await seedAuthUser({ isAnonymous: false, ageMs: 365 * 24 * 60 * 60 * 1000 });
    await seedAppUser(id, 'deleted'); // DELETE /v1/me shape: users_app soft-deleted, user kept

    await sweep(7 * 24 * 60 * 60 * 1000);

    const [userRow] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    const [appRow] = await db.select().from(usersApp).where(eq(usersApp.id, id)).limit(1);
    expect(userRow).toBeDefined();
    expect(appRow).toBeDefined();
    expect(appRow?.status).toBe('deleted');
  });

  it('preserves a deleted-user tombstone and its financial ledger when auth row is gone', async () => {
    const id = tag('deleted-tombstone');
    const orderId = tag('order');
    await seedAppUser(id, 'deleted');
    await db.insert(orders).values({
      id: orderId,
      userId: id,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 199,
      psp: 'tochka',
      ourStatus: 'paid',
    });

    const result = await sweep(7 * 24 * 60 * 60 * 1000);
    expect(result.orphaned).toBe(0);
    expect(await db.select().from(usersApp).where(eq(usersApp.id, id))).toHaveLength(1);
    expect(await db.select().from(orders).where(eq(orders.id, orderId))).toHaveLength(1);

    await db.delete(usersApp).where(eq(usersApp.id, id));
  });
});
