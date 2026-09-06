import 'dotenv/config';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  assetDeletionLeases,
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
  usersPii,
} from '@seed/db';
import { setupFolderRoutes } from '../src/folders';
import { AssetMembershipError, ensureMembership } from '../src/asset-membership';
import { syncAssetReferences } from '../src/asset-references';
import { reapExpiredGalleryItems } from '../src/gallery';
import { assertNoPlacementReads } from '../src/two-layer-guard';

let app: ReturnType<typeof Fastify>;
let userId: string;
const projectIds: string[] = [];

const headers = () => ({ 'x-test-user': userId });

beforeAll(async () => {
  userId = nid();
  await db.insert(usersApp).values({ id: userId, displayName: 'Sreda folders', locale: 'ru' });
  await db.insert(usersPii).values({ id: userId, email: `sreda-folders+${userId}@seed.local` });
  app = Fastify({ logger: false });
  const requireSession = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers['x-test-user'] !== userId) {
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return { user: { id: userId } };
  };
  setupFolderRoutes(app, requireSession);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.delete(assetDeletionLeases).where(eq(assetDeletionLeases.userId, userId));
  await db
    .delete(assetPlacements)
    .where(
      inArray(
        assetPlacements.assetId,
        db
          .select({ id: galleryItems.id })
          .from(galleryItems)
          .where(eq(galleryItems.userId, userId)),
      ),
    );
  await db.delete(assetReferences).where(eq(assetReferences.userId, userId));
  await db.delete(folders).where(eq(folders.userId, userId));
  await db.delete(galleryItems).where(eq(galleryItems.userId, userId));
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
  await db.delete(usersPii).where(eq(usersPii.id, userId));
  await db.delete(usersApp).where(eq(usersApp.id, userId));
  await pool.end();
});

async function makeProject(title = 'Проект'): Promise<string> {
  const id = nid();
  projectIds.push(id);
  await db.insert(projects).values({ id, userId, title });
  return id;
}

async function makeAsset(
  projectId: string,
  options: { createdAt?: Date; expiresAt?: Date | null } = {},
) {
  const id = nid();
  await db.insert(galleryItems).values({
    id,
    userId,
    originProjectId: projectId,
    assetUrl: `http://127.0.0.1:9000/seed-assets/${id}.png`,
    kind: 'image',
    sourceKind: 'upload',
    createdAt: options.createdAt,
    expiresAt: options.expiresAt,
  });
  return id;
}

async function makeFolder(
  projectId: string,
  name: string,
  parentId: string | null = null,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/folders`,
    headers: headers(),
    payload: { name, parentId },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

describe('folders and placements', () => {
  it('resolves owned live ids without disclosing foreign/deleted/expired identity', async () => {
    const projectId = await makeProject('Resolve lifecycle');
    const future = new Date(Date.now() + 86_400_000);
    const finiteId = await makeAsset(projectId, { expiresAt: future });
    const permanentId = await makeAsset(projectId, { expiresAt: null });
    const expiredId = await makeAsset(projectId, { expiresAt: new Date(Date.now() - 1_000) });
    const deletedId = await makeAsset(projectId, { expiresAt: future });
    await db
      .update(galleryItems)
      .set({ deletedAt: new Date() })
      .where(eq(galleryItems.id, deletedId));

    const foreignUserId = nid();
    const foreignProjectId = nid();
    const foreignId = nid();
    await db.insert(usersApp).values({ id: foreignUserId, displayName: 'Foreign', locale: 'ru' });
    await db
      .insert(usersPii)
      .values({ id: foreignUserId, email: `foreign-resolve+${foreignUserId}@seed.local` });
    await db
      .insert(projects)
      .values({ id: foreignProjectId, userId: foreignUserId, title: 'Foreign' });
    await db.insert(galleryItems).values({
      id: foreignId,
      userId: foreignUserId,
      originProjectId: foreignProjectId,
      assetUrl: `https://assets.seed.local/${foreignId}`,
      kind: 'image',
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/assets/resolve',
        headers: headers(),
        payload: {
          assetIds: [finiteId, permanentId, expiredId, deletedId, foreignId, 'missing-id'],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const assets = (response.json() as { assets: Array<Record<string, unknown>> }).assets;
      expect(assets.find((asset) => asset.id === finiteId)).toMatchObject({
        available: true,
        expiresAt: future.toISOString(),
      });
      expect(assets.find((asset) => asset.id === permanentId)).toMatchObject({
        available: true,
        expiresAt: null,
      });
      for (const id of [expiredId, deletedId, foreignId, 'missing-id']) {
        expect(assets.find((asset) => asset.id === id)).toEqual({ id, available: false });
      }
    } finally {
      await db.delete(galleryItems).where(eq(galleryItems.id, foreignId));
      await db.delete(projects).where(eq(projects.id, foreignProjectId));
      await db.delete(usersPii).where(eq(usersPii.id, foreignUserId));
      await db.delete(usersApp).where(eq(usersApp.id, foreignUserId));
    }
  });

  it('reuses production references without extending finite retention', async () => {
    const projectId = await makeProject('Reference lifecycle');
    const expiresAt = new Date(Date.now() + 60_000);
    const assetId = await makeAsset(projectId, { expiresAt });
    await db.transaction(async (tx) => {
      await syncAssetReferences(tx, {
        userId,
        refType: 'board_node',
        resourceId: 'board-ctx5',
        references: [{ assetId, slotId: 'node-1' }],
      });
      await syncAssetReferences(tx, {
        userId,
        refType: 'studio_clip',
        resourceId: 'studio-ctx5',
        references: [{ assetId, slotId: 'clip-1' }],
      });
    });
    const refs = await db
      .select({ type: assetReferences.refType, refId: assetReferences.refId })
      .from(assetReferences)
      .where(eq(assetReferences.galleryItemId, assetId));
    expect(refs).toEqual(
      expect.arrayContaining([
        { type: 'board_node', refId: 'board-ctx5:node-1' },
        { type: 'studio_clip', refId: 'studio-ctx5:clip-1' },
      ]),
    );
    const [asset] = await db
      .select({ expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(eq(galleryItems.id, assetId));
    expect(asset?.expiresAt).toEqual(expiresAt);
  });

  it('enforces the project folder limit under concurrent creates', async () => {
    const projectId = await makeProject('Лимит');
    const previous = process.env.PROJECT_FOLDER_LIMIT;
    process.env.PROJECT_FOLDER_LIMIT = '3';
    try {
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          app.inject({
            method: 'POST',
            url: `/v1/projects/${projectId}/folders`,
            headers: headers(),
            payload: { name: `Папка ${index}` },
          }),
        ),
      );
      expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(3);
      expect(responses.filter((response) => response.statusCode === 400)).toHaveLength(7);
      expect(responses.find((response) => response.statusCode === 400)?.json()).toMatchObject({
        error: 'limit_exceeded',
        limit: 3,
      });
    } finally {
      if (previous === undefined) delete process.env.PROJECT_FOLDER_LIMIT;
      else process.env.PROJECT_FOLDER_LIMIT = previous;
    }
  });

  it('creates and lists three visible project-scoped nesting levels', async () => {
    const projectId = await makeProject('Иерархия');
    const rootId = await makeFolder(projectId, 'Кампания');
    const sceneId = await makeFolder(projectId, 'Сцена 01', rootId);
    const takesId = await makeFolder(projectId, 'Дубли', sceneId);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/folders`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    const listed = (response.json() as { folders: Array<Record<string, unknown>> }).folders;
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rootId, parentId: null, childCount: 1, version: 1 }),
        expect.objectContaining({ id: sceneId, parentId: rootId, childCount: 1, version: 1 }),
        expect.objectContaining({ id: takesId, parentId: sceneId, childCount: 0, version: 1 }),
      ]),
    );
  });

  // NB the neighbouring tree test covers moving a FOLDER between projects. This
  // is the other move: a placement, i.e. filing an asset from one folder into
  // another. That path validated the source folder's owner and liveness but
  // never that it belonged to the destination's project, so one crafted request
  // added membership+placement in project B while deleting the placement from
  // project A. Same user, so not a leak — but contract §2 isolation and §5's
  // "a move is between folders in the current project" were simply unenforced.
  it('refuses to move a placement across projects, and leaves both projects untouched', async () => {
    const projectA = await makeProject('Источник');
    const projectB = await makeProject('Назначение');
    const folderA = await makeFolder(projectA, 'Папка А');
    const folderB = await makeFolder(projectB, 'Папка Б');
    const assetId = await makeAsset(projectA);

    const filed = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId: folderA },
    });
    expect(filed.statusCode, filed.body).toBe(201);

    const crossed = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId: folderB, fromFolderId: folderA },
    });
    expect(crossed.statusCode, crossed.body).toBe(409);
    expect(crossed.json()).toMatchObject({ error: 'cross_project_move' });

    // The whole transaction must roll back: the asset stays filed in A and
    // gains nothing in B. A 409 that still moved half the state is worse than
    // no check at all.
    const placements = await db
      .select({ folderId: assetPlacements.folderId })
      .from(assetPlacements)
      .where(eq(assetPlacements.assetId, assetId));
    expect(placements.map((row) => row.folderId)).toEqual([folderA]);
  });

  it('prevents self-parenting, cycles, cross-project moves, and foreign parents', async () => {
    const projectId = await makeProject('Правила дерева');
    const otherProjectId = await makeProject('Другой проект');
    const rootId = await makeFolder(projectId, 'Корень');
    const childId = await makeFolder(projectId, 'Ребёнок', rootId);
    const otherId = await makeFolder(otherProjectId, 'Чужой проект');

    const self = await app.inject({
      method: 'PATCH',
      url: `/v1/folders/${rootId}`,
      headers: headers(),
      payload: { parentId: rootId, expectedVersion: 1 },
    });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ error: 'self_parent' });

    const cycle = await app.inject({
      method: 'PATCH',
      url: `/v1/folders/${rootId}`,
      headers: headers(),
      payload: { parentId: childId, expectedVersion: 1 },
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json()).toMatchObject({ error: 'folder_cycle' });

    const crossProject = await app.inject({
      method: 'PATCH',
      url: `/v1/folders/${childId}`,
      headers: headers(),
      payload: { parentId: otherId, expectedVersion: 1 },
    });
    expect(crossProject.statusCode).toBe(409);
    expect(crossProject.json()).toMatchObject({ error: 'cross_project_parent' });

    const foreignUserId = nid();
    const foreignProjectId = nid();
    const foreignFolderId = nid();
    await db.insert(usersApp).values({ id: foreignUserId, displayName: 'Foreign folders' });
    await db
      .insert(usersPii)
      .values({ id: foreignUserId, email: `foreign-folders+${foreignUserId}@seed.local` });
    await db
      .insert(projects)
      .values({ id: foreignProjectId, userId: foreignUserId, title: 'Foreign tree' });
    await db.insert(folders).values({
      id: foreignFolderId,
      projectId: foreignProjectId,
      userId: foreignUserId,
      name: 'Foreign root',
    });
    try {
      const foreign = await app.inject({
        method: 'PATCH',
        url: `/v1/folders/${childId}`,
        headers: headers(),
        payload: { parentId: foreignFolderId, expectedVersion: 1 },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toMatchObject({ error: 'not_found' });
      const hidden = await app.inject({
        method: 'GET',
        url: `/v1/folders/${foreignFolderId}/assets`,
        headers: headers(),
      });
      expect(hidden.statusCode).toBe(404);
    } finally {
      await db.delete(folders).where(eq(folders.id, foreignFolderId));
      await db.delete(projects).where(eq(projects.id, foreignProjectId));
      await db.delete(usersPii).where(eq(usersPii.id, foreignUserId));
      await db.delete(usersApp).where(eq(usersApp.id, foreignUserId));
    }
  });

  it('uses version conflicts to serialize concurrent rename and move operations', async () => {
    const projectId = await makeProject('Конкурентность');
    const firstParentId = await makeFolder(projectId, 'Первая');
    const secondParentId = await makeFolder(projectId, 'Вторая');
    const childId = await makeFolder(projectId, 'Материалы', firstParentId);

    const renames = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/v1/folders/${childId}`,
        headers: headers(),
        payload: { name: 'Монтаж', expectedVersion: 1 },
      }),
      app.inject({
        method: 'PATCH',
        url: `/v1/folders/${childId}`,
        headers: headers(),
        payload: { name: 'Финал', expectedVersion: 1 },
      }),
    ]);
    expect(renames.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(renames.find((response) => response.statusCode === 409)?.json()).toMatchObject({
      error: 'stale_folder',
      currentVersion: 2,
    });

    const move = await app.inject({
      method: 'PATCH',
      url: `/v1/folders/${childId}`,
      headers: headers(),
      payload: { parentId: secondParentId, expectedVersion: 2 },
    });
    expect(move.statusCode, move.body).toBe(200);
    expect(move.json()).toMatchObject({ parentId: secondParentId, version: 3 });
    const staleMove = await app.inject({
      method: 'PATCH',
      url: `/v1/folders/${childId}`,
      headers: headers(),
      payload: { parentId: firstParentId, expectedVersion: 2 },
    });
    expect(staleMove.statusCode).toBe(409);
    expect(staleMove.json()).toMatchObject({ error: 'stale_folder', currentVersion: 3 });
  });

  it('serializes a concurrent move against deletion without a partial tree state', async () => {
    const projectId = await makeProject('Move-delete race');
    const firstParentId = await makeFolder(projectId, 'Source');
    const secondParentId = await makeFolder(projectId, 'Destination');
    const childId = await makeFolder(projectId, 'Racing folder', firstParentId);

    const [move, remove] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/v1/folders/${childId}`,
        headers: headers(),
        payload: { parentId: secondParentId, expectedVersion: 1 },
      }),
      app.inject({
        method: 'DELETE',
        url: `/v1/folders/${childId}?expectedVersion=1`,
        headers: headers(),
      }),
    ]);
    expect([move.statusCode, remove.statusCode].filter((status) => status === 200)).toHaveLength(1);
    expect([404, 409]).toContain(
      [move.statusCode, remove.statusCode].find((status) => status !== 200),
    );
    const rows = await db.select().from(folders).where(eq(folders.id, childId));
    if (move.statusCode === 200) {
      expect(rows).toEqual([expect.objectContaining({ parentId: secondParentId, version: 2 })]);
    } else {
      expect(rows).toHaveLength(0);
    }
  });

  it('adds and removes free placements without changing the 30-day retention clock', async () => {
    const projectId = await makeProject('Размещение');
    const folderId = await makeFolder(projectId, 'Референсы');
    const expiresAt = new Date(Date.now() + 60_000);
    const assetId = await makeAsset(projectId, { expiresAt });
    const add = () =>
      app.inject({
        method: 'POST',
        url: `/v1/assets/${assetId}/placements`,
        headers: headers(),
        payload: { folderId },
      });
    expect((await add()).json()).toMatchObject({ ok: true, created: true });
    expect((await add()).json()).toMatchObject({ ok: true, created: false });
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toHaveLength(1);
    expect(
      (await db.select().from(galleryItems).where(eq(galleryItems.id, assetId)))[0]?.expiresAt,
    ).toEqual(expiresAt);
    expect(
      await db
        .select()
        .from(assetReferences)
        .where(
          and(eq(assetReferences.galleryItemId, assetId), eq(assetReferences.refType, 'keep')),
        ),
    ).toHaveLength(0);

    const remove = () =>
      app.inject({
        method: 'DELETE',
        url: `/v1/assets/${assetId}/placements/${folderId}`,
        headers: headers(),
      });
    expect((await remove()).json()).toMatchObject({ ok: true, removed: true });
    expect((await remove()).json()).toMatchObject({ ok: true, removed: false });
    expect(
      await db
        .select()
        .from(assetReferences)
        .where(
          and(eq(assetReferences.galleryItemId, assetId), eq(assetReferences.refType, 'keep')),
        ),
    ).toHaveLength(0);
    expect(
      (await db.select().from(galleryItems).where(eq(galleryItems.id, assetId)))[0]?.expiresAt,
    ).toEqual(expiresAt);
  });

  it('makes a placed asset permanent only for a paid account', async () => {
    const projectId = await makeProject('Платное хранение');
    const folderId = await makeFolder(projectId, 'Навсегда');
    const assetId = await makeAsset(projectId, { expiresAt: new Date(Date.now() + 60_000) });
    await db.update(usersApp).set({ tier: 'start' }).where(eq(usersApp.id, userId));
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/assets/${assetId}/placements`,
        headers: headers(),
        payload: { folderId },
      });
      expect(response.statusCode).toBe(201);
      expect(
        (await db.select().from(galleryItems).where(eq(galleryItems.id, assetId)))[0]?.expiresAt,
      ).toBeNull();
      expect(
        await db
          .select()
          .from(assetReferences)
          .where(
            and(eq(assetReferences.galleryItemId, assetId), eq(assetReferences.refType, 'keep')),
          ),
      ).toHaveLength(1);
    } finally {
      await db.update(usersApp).set({ tier: 'free' }).where(eq(usersApp.id, userId));
    }
  });

  it('places one library asset into two projects and creates both memberships', async () => {
    const first = await makeProject('А');
    const second = await makeProject('Б');
    const assetId = nid();
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `http://127.0.0.1:9000/seed-assets/${assetId}.png`,
      kind: 'image',
      sourceKind: 'upload',
    });
    const firstFolderId = await makeFolder(first, 'Первая');
    const secondFolderId = await makeFolder(second, 'Вторая');
    const firstPlacement = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId: firstFolderId },
    });
    expect(firstPlacement.statusCode).toBe(201);
    const secondPlacement = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId: secondFolderId },
    });
    expect(secondPlacement.statusCode).toBe(201);
    const memberships = await db
      .select()
      .from(projectAssets)
      .where(eq(projectAssets.assetId, assetId));
    expect(memberships).toHaveLength(2);
    expect(memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: first, assetId, userId }),
        expect.objectContaining({ projectId: second, assetId, userId }),
      ]),
    );
  });

  it('rejects a membership write when the requested user violates ownership', async () => {
    const projectId = await makeProject('Инвариант владения');
    const assetId = await makeAsset(projectId);
    await expect(
      db.transaction((tx) => ensureMembership(tx, projectId, assetId, nid())),
    ).rejects.toBeInstanceOf(AssetMembershipError);
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId)),
    ).toHaveLength(0);
  });

  it('moves between user folders atomically and reports folder usage in batches', async () => {
    const projectId = await makeProject('Монтаж папок');
    const sourceId = await makeFolder(projectId, 'Черновики');
    const targetId = await makeFolder(projectId, 'Отбор');
    const assetId = await makeAsset(projectId);
    await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId: sourceId },
    });

    const moved = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId: targetId, fromFolderId: sourceId },
    });
    expect(moved.statusCode).toBe(201);
    expect(moved.json()).toMatchObject({ ok: true, created: true, moved: true });
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toEqual([expect.objectContaining({ folderId: targetId })]);

    const usage = await app.inject({
      method: 'POST',
      url: '/v1/assets/usage',
      headers: headers(),
      payload: { assetIds: [assetId] },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toEqual({ usages: { [assetId]: ['Отбор'] } });
  });

  it('creates a named folder with an existing asset in one transaction', async () => {
    const projectId = await makeProject('Новая папка');
    const assetId = await makeAsset(projectId);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements/new-folder`,
      headers: headers(),
      payload: { projectId, name: 'Референсы героя' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { folder: { id: string; name: string } };
    expect(body.folder.name).toBe('Референсы героя');
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toEqual([expect.objectContaining({ folderId: body.folder.id })]);
  });

  it('deleting a folder removes placements but keeps its assets in Recents', async () => {
    const projectId = await makeProject('Удаление папки');
    const folderId = await makeFolder(projectId, 'Временная');
    const assetId = await makeAsset(projectId);
    await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId },
    });
    const protectedDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/folders/${folderId}`,
      headers: headers(),
    });
    expect(protectedDelete.statusCode).toBe(409);
    expect(protectedDelete.json()).toMatchObject({
      error: 'folder_not_empty',
      placements: 1,
      recursiveRequired: true,
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/folders/${folderId}?recursive=true&expectedVersion=1`,
      headers: headers(),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      foldersDeleted: 1,
      placementsRemoved: 1,
      assetsDeleted: 0,
    });
    expect(await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))).toHaveLength(
      1,
    );
    const recents = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/recents`,
      headers: headers(),
    });
    expect(
      (recents.json() as { items: Array<{ id: string }> }).items.some(
        (item) => item.id === assetId,
      ),
    ).toBe(true);
  });

  it('recursively deletes a non-empty subtree but never its underlying media', async () => {
    const projectId = await makeProject('Удаление дерева');
    const rootId = await makeFolder(projectId, 'Корень');
    const childId = await makeFolder(projectId, 'Вложенная', rootId);
    const leafId = await makeFolder(projectId, 'Третий уровень', childId);
    const assetId = await makeAsset(projectId);
    await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId: leafId },
    });

    const rejected = await app.inject({
      method: 'DELETE',
      url: `/v1/folders/${rootId}?expectedVersion=1`,
      headers: headers(),
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: 'folder_not_empty',
      childFolders: 2,
      placements: 1,
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/folders/${rootId}?recursive=true&expectedVersion=1`,
      headers: headers(),
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({
      foldersDeleted: 3,
      placementsRemoved: 1,
      assetsDeleted: 0,
    });
    expect(
      await db
        .select()
        .from(folders)
        .where(inArray(folders.id, [rootId, childId, leafId])),
    ).toHaveLength(0);
    expect(await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))).toHaveLength(
      1,
    );
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId)),
    ).toHaveLength(1);
  });

  it('Recents is chronological, includes filed assets, and excludes items older than 30 days', async () => {
    const projectId = await makeProject('Недавние');
    const folderId = await makeFolder(projectId, 'Монтаж');
    const recentId = await makeAsset(projectId, { createdAt: new Date() });
    const oldId = await makeAsset(projectId, {
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/assets/${recentId}/placements`,
      headers: headers(),
      payload: { folderId },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/recents?limit=1`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ id: string; sourceLine: string }> };
    expect(body.items).toEqual([expect.objectContaining({ id: recentId, sourceLine: 'загрузка' })]);
    expect(body.items.some((item) => item.id === oldId)).toBe(false);
  });

  it('hides expired media from folder contents, Recents, and folder counts', async () => {
    const projectId = await makeProject('Истёкшие медиа');
    const folderId = await makeFolder(projectId, 'Архив');
    const expiredId = await makeAsset(projectId, { expiresAt: new Date(Date.now() - 1_000) });
    const futureId = await makeAsset(projectId, { expiresAt: new Date(Date.now() + 86_400_000) });
    const permanentId = await makeAsset(projectId, { expiresAt: null });

    for (const assetId of [expiredId, futureId, permanentId]) {
      const placement = await app.inject({
        method: 'POST',
        url: `/v1/assets/${assetId}/placements`,
        headers: headers(),
        payload: { folderId },
      });
      expect(placement.statusCode, placement.body).toBe(201);
    }

    const [folderAssets, recents, foldersResponse] = await Promise.all([
      app.inject({ method: 'GET', url: `/v1/folders/${folderId}/assets`, headers: headers() }),
      app.inject({ method: 'GET', url: `/v1/projects/${projectId}/recents`, headers: headers() }),
      app.inject({ method: 'GET', url: `/v1/projects/${projectId}/folders`, headers: headers() }),
    ]);
    expect(folderAssets.statusCode, folderAssets.body).toBe(200);
    expect(recents.statusCode, recents.body).toBe(200);
    expect(foldersResponse.statusCode, foldersResponse.body).toBe(200);

    const expectedIds = [futureId, permanentId].sort();
    expect({
      folder: (folderAssets.json() as { items: Array<{ asset: { id: string } }> }).items
        .map((item) => item.asset.id)
        .sort(),
      recents: (recents.json() as { items: Array<{ id: string }> }).items
        .map((item) => item.id)
        .sort(),
      count: (
        foldersResponse.json() as { folders: Array<{ id: string; count: number }> }
      ).folders.find((folder) => folder.id === folderId)?.count,
    }).toEqual({ folder: expectedIds, recents: expectedIds, count: 2 });
  });

  it('shows a sticky zero-placement member by membership addedAt, not asset origin', async () => {
    const originProjectId = await makeProject('Источник');
    const memberProjectId = await makeProject('Участник');
    const assetId = await makeAsset(originProjectId, {
      createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
    });
    const addedAt = new Date();
    await db.insert(projectAssets).values({
      projectId: memberProjectId,
      assetId,
      userId,
      addedAt,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${memberProjectId}/recents`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [expect.objectContaining({ id: assetId, addedAt: addedAt.toISOString() })],
    });
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toHaveLength(0);
  });

  it('paginates Recents with an addedAt cursor distinct from folder cursors', async () => {
    const projectId = await makeProject('Пагинация членства');
    const firstId = await makeAsset(projectId);
    const secondId = await makeAsset(projectId);
    await db.insert(projectAssets).values([
      { projectId, assetId: firstId, userId, addedAt: new Date(Date.now() - 1_000) },
      { projectId, assetId: secondId, userId, addedAt: new Date() },
    ]);
    const firstPage = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/recents?limit=1`,
      headers: headers(),
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json() as { items: Array<{ id: string }>; nextCursor: string };
    expect(firstBody.items).toHaveLength(1);
    const decoded = JSON.parse(Buffer.from(firstBody.nextCursor, 'base64url').toString('utf8')) as {
      addedAt?: string;
      createdAt?: string;
    };
    expect(decoded.addedAt).toBeTypeOf('string');
    expect(decoded.createdAt).toBeUndefined();
    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/recents?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      headers: headers(),
    });
    expect(secondPage.statusCode).toBe(200);
    expect((secondPage.json() as { items: Array<{ id: string }> }).items).toHaveLength(1);
  });

  it('the API reaper expires a free asset even when it was filed', async () => {
    const projectId = await makeProject('Срок');
    const folderId = await makeFolder(projectId, 'Оставить');
    const assetId = await makeAsset(projectId, { expiresAt: new Date(Date.now() - 60_000) });
    await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId },
    });
    await reapExpiredGalleryItems();
    expect(await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toHaveLength(0);
  });

  it('the API reaper removes an expired placement even without legacy keep metadata', async () => {
    const projectId = await makeProject('Срок без keep');
    const folderId = await makeFolder(projectId, 'Оставить без keep');
    const assetId = await makeAsset(projectId, { expiresAt: new Date(Date.now() - 60_000) });
    await db.insert(assetPlacements).values({ assetId, folderId });

    await expect(reapExpiredGalleryItems()).resolves.toBeDefined();
    expect(await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))).toHaveLength(
      0,
    );
  });

  it('guards production references and supports the short asset-delete undo', async () => {
    const projectId = await makeProject('Удаление материала');
    const assetId = await makeAsset(projectId);
    await db.insert(projectAssets).values({ projectId, assetId, userId });
    await db.insert(assetReferences).values({
      id: nid(),
      galleryItemId: assetId,
      userId,
      refType: 'board_node',
      refId: 'board:node-1',
    });
    const refused = await app.inject({
      method: 'DELETE',
      url: `/v1/assets/${assetId}`,
      headers: headers(),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'asset_in_use', count: 1 });
    await db.delete(assetReferences).where(eq(assetReferences.galleryItemId, assetId));
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/assets/${assetId}`,
      headers: headers(),
    });
    expect(deleted.statusCode).toBe(200);
    const [hidden] = await db.select().from(galleryItems).where(eq(galleryItems.id, assetId));
    expect(hidden?.deletedAt).toBeInstanceOf(Date);
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId)),
    ).toHaveLength(1);
    const restored = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/restore`,
      headers: headers(),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ ok: true, placementsRestored: 0 });
    const [visible] = await db.select().from(galleryItems).where(eq(galleryItems.id, assetId));
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId)),
    ).toHaveLength(1);
    expect(visible?.deletedAt).toBeNull();
    expect(
      await db
        .select()
        .from(assetReferences)
        .where(
          and(eq(assetReferences.galleryItemId, assetId), eq(assetReferences.refType, 'keep')),
        ),
    ).toHaveLength(0);
  });

  it('restores all recorded placements without granting free permanent storage', async () => {
    const projectId = await makeProject('Полное восстановление');
    const firstFolderId = await makeFolder(projectId, 'Первая');
    const secondFolderId = await makeFolder(projectId, 'Вторая');
    const previousExpiresAt = new Date(Date.now() + 90_000);
    const assetId = await makeAsset(projectId, { expiresAt: previousExpiresAt });
    for (const folderId of [firstFolderId, secondFolderId]) {
      await app.inject({
        method: 'POST',
        url: `/v1/assets/${assetId}/placements`,
        headers: headers(),
        payload: { folderId },
      });
    }

    await app.inject({ method: 'DELETE', url: `/v1/assets/${assetId}`, headers: headers() });
    const [lease] = await db
      .select()
      .from(assetDeletionLeases)
      .where(eq(assetDeletionLeases.assetId, assetId));
    expect(new Set(lease?.folderIds)).toEqual(new Set([firstFolderId, secondFolderId]));
    const restored = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/restore`,
      headers: headers(),
    });
    expect(restored.json()).toEqual({ ok: true, placementsRestored: 2 });
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(assetReferences)
        .where(
          and(eq(assetReferences.galleryItemId, assetId), eq(assetReferences.refType, 'keep')),
        ),
    ).toHaveLength(0);
    const [asset] = await db.select().from(galleryItems).where(eq(galleryItems.id, assetId));
    expect(asset?.expiresAt?.getTime()).toBe(previousExpiresAt.getTime());
  });

  it('restores only the recorded folders that still exist', async () => {
    const projectId = await makeProject('Частичное восстановление');
    const survivingId = await makeFolder(projectId, 'Остаётся');
    const removedId = await makeFolder(projectId, 'Исчезает');
    const assetId = await makeAsset(projectId);
    const beforeRestore = Date.now();
    for (const folderId of [survivingId, removedId]) {
      await app.inject({
        method: 'POST',
        url: `/v1/assets/${assetId}/placements`,
        headers: headers(),
        payload: { folderId },
      });
    }
    await app.inject({ method: 'DELETE', url: `/v1/assets/${assetId}`, headers: headers() });
    await db.delete(folders).where(eq(folders.id, removedId));

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/restore`,
      headers: headers(),
    });
    expect(restored.json()).toEqual({ ok: true, placementsRestored: 1 });
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toEqual([expect.objectContaining({ folderId: survivingId })]);
    const [asset] = await db.select().from(galleryItems).where(eq(galleryItems.id, assetId));
    expect(asset?.expiresAt).toBeInstanceOf(Date);
    expect(asset!.expiresAt!.getTime()).toBeGreaterThanOrEqual(
      beforeRestore + 30 * 24 * 60 * 60 * 1000,
    );
  });

  it('restores unfiled without a keep reference when every recorded folder is gone', async () => {
    const projectId = await makeProject('Папки исчезли');
    const folderId = await makeFolder(projectId, 'Временная');
    const previousExpiresAt = new Date(Date.now() + 120_000);
    const assetId = await makeAsset(projectId, { expiresAt: previousExpiresAt });
    await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId },
    });
    await app.inject({ method: 'DELETE', url: `/v1/assets/${assetId}`, headers: headers() });
    await db.delete(folders).where(eq(folders.id, folderId));

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/restore`,
      headers: headers(),
    });
    expect(restored.json()).toEqual({ ok: true, placementsRestored: 0 });
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(assetReferences)
        .where(
          and(eq(assetReferences.galleryItemId, assetId), eq(assetReferences.refType, 'keep')),
        ),
    ).toHaveLength(0);
    const [asset] = await db.select().from(galleryItems).where(eq(galleryItems.id, assetId));
    expect(asset?.expiresAt?.getTime()).toBe(previousExpiresAt.getTime());
  });

  it('hides every folder and placement operation under a soft-deleted project', async () => {
    const projectId = await makeProject('Скрытый проект');
    const folderId = await makeFolder(projectId, 'Скрытая');
    const assetId = await makeAsset(projectId);
    await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/placements`,
      headers: headers(),
      payload: { folderId },
    });
    await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, projectId));

    const responses = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/v1/folders/${folderId}`,
        headers: headers(),
        payload: { name: 'Нельзя' },
      }),
      app.inject({ method: 'GET', url: `/v1/folders/${folderId}/assets`, headers: headers() }),
      app.inject({
        method: 'POST',
        url: `/v1/assets/${assetId}/placements`,
        headers: headers(),
        payload: { folderId },
      }),
      app.inject({
        method: 'DELETE',
        url: `/v1/assets/${assetId}/placements/${folderId}`,
        headers: headers(),
      }),
      app.inject({
        method: 'POST',
        url: `/v1/assets/${assetId}/placements/new-folder`,
        headers: headers(),
        payload: { projectId, name: 'Новая' },
      }),
    ]);
    const deleteFolder = await app.inject({
      method: 'DELETE',
      url: `/v1/folders/${folderId}`,
      headers: headers(),
    });
    expect([...responses, deleteFolder].map((response) => response.statusCode)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    expect(await db.select().from(folders).where(eq(folders.id, folderId))).toHaveLength(1);
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toHaveLength(1);
  });

  it('preflights a mixed batch before any upload starts', async () => {
    const projectId = await makeProject('Проверка файлов');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/assets/preflight`,
      headers: headers(),
      payload: {
        files: [
          { name: 'кадр.png', size: 100, type: 'image/png' },
          { name: 'архив.zip', size: 100, type: 'application/zip' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      canUpload: false,
      accepted: [{ index: 0, name: 'кадр.png' }],
      rejected: [{ index: 1, name: 'архив.zip', reason: 'Неподдерживаемый формат' }],
    });
  });
});

const freeMediaRetentionMigration = resolve(
  process.cwd(),
  '../../packages/db/migrations/0056_free_media_retention_30_days.sql',
);

async function applyFreeMediaRetentionMigration(): Promise<void> {
  const statements = (await readFile(freeMediaRetentionMigration, 'utf8'))
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

describe('free-media retention migration', () => {
  it('extends live and soft-deleted free assets without resurrecting, unbounding, or changing paid assets', async () => {
    const projectId = await makeProject('Миграция хранения');
    const day = 24 * 60 * 60 * 1000;
    const legacyDeadline = new Date(Date.now() + 7 * day);
    const liveId = await makeAsset(projectId, { expiresAt: legacyDeadline });
    const expiredId = await makeAsset(projectId, {
      expiresAt: new Date(Date.now() - day),
    });
    const paidId = await makeAsset(projectId, { expiresAt: null });
    const alreadyThirtyDaysId = await makeAsset(projectId, {
      expiresAt: new Date(Date.now() + 30 * day),
    });
    const softDeletedId = await makeAsset(projectId, { expiresAt: legacyDeadline });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/assets/${softDeletedId}`,
      headers: headers(),
    });
    expect(deleted.statusCode).toBe(200);

    await applyFreeMediaRetentionMigration();

    const rowsAfterFirstRun = await db
      .select({ id: galleryItems.id, expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(inArray(galleryItems.id, [liveId, expiredId, paidId, alreadyThirtyDaysId]));
    const byIdAfterFirstRun = new Map(rowsAfterFirstRun.map((row) => [row.id, row.expiresAt]));

    // 1. A live legacy row gains 23 days.
    expect(byIdAfterFirstRun.get(liveId)?.getTime()).toBe(legacyDeadline.getTime() + 23 * day);
    // 2. An expired row is untouched, so it cannot be resurrected.
    expect(byIdAfterFirstRun.get(expiredId)?.getTime()).toBeLessThan(Date.now());
    // 3. Paid media remains permanent.
    expect(byIdAfterFirstRun.get(paidId)).toBeNull();
    // 4. A new-code 30-day row is capped instead of becoming 53 days.
    expect(byIdAfterFirstRun.get(alreadyThirtyDaysId)?.getTime()).toBeLessThanOrEqual(
      Date.now() + 30 * day,
    );

    const [leaseAfterFirstRun] = await db
      .select()
      .from(assetDeletionLeases)
      .where(eq(assetDeletionLeases.assetId, softDeletedId));
    expect(leaseAfterFirstRun?.previousExpiresAt?.getTime()).toBe(
      legacyDeadline.getTime() + 23 * day,
    );

    await applyFreeMediaRetentionMigration();

    const rowsAfterSecondRun = await db
      .select({ id: galleryItems.id, expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(inArray(galleryItems.id, [liveId, alreadyThirtyDaysId]));
    // 5. Replaying the migration keeps every live deadline within 30 days of that run.
    for (const row of rowsAfterSecondRun) {
      expect(row.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 30 * day);
    }

    const [leaseAfterSecondRun] = await db
      .select()
      .from(assetDeletionLeases)
      .where(eq(assetDeletionLeases.assetId, softDeletedId));
    expect(leaseAfterSecondRun?.previousExpiresAt?.getTime()).toBeGreaterThan(
      legacyDeadline.getTime() + 22 * day,
    );

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/assets/${softDeletedId}/restore`,
      headers: headers(),
    });
    expect(restored.statusCode).toBe(200);
    const [restoredAsset] = await db
      .select()
      .from(galleryItems)
      .where(eq(galleryItems.id, softDeletedId));
    // 6. A deleted asset restores the migrated lease deadline verbatim.
    expect(restoredAsset?.expiresAt?.getTime()).toBe(
      leaseAfterSecondRun?.previousExpiresAt?.getTime(),
    );
  });
});

async function sourceFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|tsx|mjs|cjs|sql)$/.test(entry.name))
      files.push({ path, content: await readFile(path, 'utf8') });
  }
  return files;
}

async function repositoryGuardFiles(): Promise<Array<{ path: string; content: string }>> {
  const repo = resolve(import.meta.dirname, '../../..');
  const files = await sourceFiles(resolve(repo, 'apps/worker/src'));
  for (const path of ['apps/api/src/jobs-routes.ts', 'apps/api/src/studio.ts']) {
    files.push({ path, content: await readFile(resolve(repo, path), 'utf8') });
  }
  return files;
}

describe('two-layer CI guard', () => {
  it('keeps production and render paths independent from placements', async () => {
    const files = await repositoryGuardFiles();
    expect(() => assertNoPlacementReads(files)).not.toThrow();
  });

  it('demonstrates the real repository guard goes red for a Drizzle placement import', async () => {
    const repo = resolve(import.meta.dirname, '../../..');
    const plantedPath = resolve(repo, 'apps/worker/src', `guard-red-demo-${nid()}.ts`);
    await writeFile(plantedPath, "import { assetPlacements } from '@seed/db';\n", 'utf8');
    try {
      const files = await repositoryGuardFiles();
      expect(() => assertNoPlacementReads(files)).toThrow(
        new RegExp(plantedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      await unlink(plantedPath);
    }
  });
});
