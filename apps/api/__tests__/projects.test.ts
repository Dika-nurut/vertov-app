import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import {
  assetPlacements,
  assetReferences,
  boards,
  db,
  folders,
  galleryItems,
  nid,
  pool,
  projectAssets,
  projects,
  scripts,
  studioProjects,
  usersApp,
  usersPii,
} from '@seed/db';
import { setupGalleryRoutes } from '../src/gallery';
import { setupFolderRoutes } from '../src/folders';
import { setupProjectRoutes } from '../src/projects';

let app: ReturnType<typeof Fastify>;
let userId: string;

const headers = () => ({ 'x-test-user': userId });

beforeAll(async () => {
  userId = nid();
  await db.insert(usersApp).values({ id: userId, displayName: 'Sreda test', locale: 'ru' });
  await db.insert(usersPii).values({ id: userId, email: `sreda-projects+${userId}@seed.local` });
  app = Fastify({ logger: false });
  const requireSession = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers['x-test-user'] !== userId) {
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return { user: { id: userId } };
  };
  setupProjectRoutes(app, requireSession);
  setupGalleryRoutes(app, requireSession);
  setupFolderRoutes(app, requireSession);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const assets = await db
    .select({ id: galleryItems.id })
    .from(galleryItems)
    .where(eq(galleryItems.userId, userId));
  const assetIds = assets.map((asset) => asset.id);
  if (assetIds.length > 0) {
    await db.delete(assetPlacements).where(inArray(assetPlacements.assetId, assetIds));
    await db.delete(assetReferences).where(inArray(assetReferences.galleryItemId, assetIds));
  }
  await db.delete(folders).where(eq(folders.userId, userId));
  await db.delete(galleryItems).where(eq(galleryItems.userId, userId));
  await db.delete(projects).where(eq(projects.userId, userId));
  await db.delete(usersPii).where(eq(usersPii.id, userId));
  await db.delete(usersApp).where(eq(usersApp.id, userId));
  await pool.end();
});

async function createProject(title: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: headers(),
    payload: { title },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

describe('projects', () => {
  it('lazy attach is idempotent', async () => {
    const projectId = await createProject('Клип');
    const boardId = nid();
    await db.insert(boards).values({ id: boardId, userId, title: 'Кадры', state: {} });
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/v1/projects/attach',
        headers: headers(),
        payload: { projectId, resources: [{ type: 'board', id: boardId }] },
      });
    const first = await request();
    const second = await request();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ projectId, attached: 1 });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ projectId, attached: 0 });
    const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
    expect(board?.projectId).toBe(projectId);
  });

  it('rejects an attach across projects without partially moving resources', async () => {
    const firstProjectId = await createProject('Первый');
    const secondProjectId = await createProject('Второй');
    const attachedId = nid();
    const freeId = nid();
    await db.insert(boards).values([
      { id: attachedId, userId, title: 'Занято', state: {}, projectId: firstProjectId },
      { id: freeId, userId, title: 'Свободно', state: {} },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects/attach',
      headers: headers(),
      payload: {
        projectId: secondProjectId,
        resources: [
          { type: 'board', id: freeId },
          { type: 'board', id: attachedId },
        ],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'project_mismatch',
      expectedProjectId: secondProjectId,
      actualProjectId: firstProjectId,
    });
    const [free] = await db.select().from(boards).where(eq(boards.id, freeId));
    expect(free?.projectId).toBeNull();
  });

  it('attaches one media asset to two projects while keeping exclusive resources exclusive', async () => {
    const firstProjectId = await createProject('Медиа А');
    const secondProjectId = await createProject('Медиа Б');
    const assetId = nid();
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      originProjectId: firstProjectId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
    });
    for (const projectId of [firstProjectId, secondProjectId]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects/attach',
        headers: headers(),
        payload: { projectId, resources: [{ type: 'asset', id: assetId }] },
      });
      expect(response.statusCode).toBe(200);
    }
    const memberships = await db
      .select()
      .from(projectAssets)
      .where(eq(projectAssets.assetId, assetId));
    expect(memberships).toHaveLength(2);
    expect(memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: firstProjectId, assetId, userId }),
        expect.objectContaining({ projectId: secondProjectId, assetId, userId }),
      ]),
    );
  });

  it('rolls back media membership when a mixed attach contains a board mismatch', async () => {
    const firstProjectId = await createProject('Смешанный А');
    const secondProjectId = await createProject('Смешанный Б');
    const boardId = nid();
    const assetId = nid();
    await db.insert(boards).values({
      id: boardId,
      userId,
      title: 'Эксклюзивный борд',
      state: {},
      projectId: firstProjectId,
    });
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects/attach',
      headers: headers(),
      payload: {
        projectId: secondProjectId,
        resources: [
          { type: 'asset', id: assetId },
          { type: 'board', id: boardId },
        ],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'project_mismatch' });
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId)),
    ).toHaveLength(0);
  });

  it('does not create a project when create-and-attach validation fails', async () => {
    const occupiedProjectId = await createProject('Занятый источник');
    const boardId = nid();
    const assetId = nid();
    await db.insert(boards).values({
      id: boardId,
      userId,
      title: 'Занятый борд',
      state: {},
      projectId: occupiedProjectId,
    });
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
    });
    const [before] = await db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.userId, userId));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects/attach',
      headers: headers(),
      payload: {
        create: { title: 'Не должен появиться' },
        resources: [
          { type: 'asset', id: assetId },
          { type: 'board', id: boardId },
        ],
      },
    });
    expect(response.statusCode).toBe(409);
    const [after] = await db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.userId, userId));
    expect(after?.value).toBe(before?.value);
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId)),
    ).toHaveLength(0);
  });

  it('removes an asset from one project without deleting it from the library', async () => {
    const firstProjectId = await createProject('Удаление участия');
    const secondProjectId = await createProject('Оставшееся участие');
    const folderId = nid();
    const assetId = nid();
    await db.insert(folders).values({
      id: folderId,
      projectId: firstProjectId,
      userId,
      name: 'Временная',
    });
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
    });
    await db.insert(projectAssets).values([
      { projectId: firstProjectId, assetId, userId },
      { projectId: secondProjectId, assetId, userId },
    ]);
    await db.insert(assetPlacements).values({ assetId, folderId });
    await db.insert(assetReferences).values({
      id: nid(),
      galleryItemId: assetId,
      userId,
      refType: 'keep',
      refId: 'folder-placement',
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${firstProjectId}/assets/${assetId}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, removed: true, placementsRemoved: 1 });
    expect(await db.select().from(projectAssets).where(eq(projectAssets.assetId, assetId))).toEqual(
      [expect.objectContaining({ projectId: secondProjectId })],
    );
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
    const gallery = await app.inject({ method: 'GET', url: '/v1/gallery', headers: headers() });
    expect(gallery.statusCode).toBe(200);
    expect(
      (gallery.json() as { rows: Array<{ id: string }> }).rows.some((item) => item.id === assetId),
    ).toBe(true);
  });

  it('serializes remove-from-project with concurrent placement lifecycle writes', async () => {
    const firstProjectId = await createProject('Удаление под блокировкой');
    const secondProjectId = await createProject('Параллельная раскладка');
    const firstFolderId = nid();
    const secondFolderId = nid();
    const assetId = nid();
    await db.insert(folders).values([
      {
        id: firstFolderId,
        projectId: firstProjectId,
        userId,
        name: 'Удаляемая',
      },
      {
        id: secondFolderId,
        projectId: secondProjectId,
        userId,
        name: 'Параллельная',
      },
    ]);
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
    });
    await db.insert(projectAssets).values([
      { projectId: firstProjectId, assetId, userId },
      { projectId: secondProjectId, assetId, userId },
    ]);
    await db.insert(assetPlacements).values({ assetId, folderId: firstFolderId });
    await db.insert(assetReferences).values({
      id: nid(),
      galleryItemId: assetId,
      userId,
      refType: 'keep',
      refId: 'folder-placement',
    });

    let markLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      markLockAcquired = resolve;
    });
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${assetId}))`);
      markLockAcquired();
      await holderReleased;
      await tx.insert(assetPlacements).values({ assetId, folderId: secondFolderId });
    });
    await lockAcquired;

    const removal = app.inject({
      method: 'DELETE',
      url: `/v1/projects/${firstProjectId}/assets/${assetId}`,
      headers: headers(),
    });
    const stateBeforeRelease = await Promise.race([
      removal.then(() => 'settled' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ]);
    releaseHolder();
    await holder;
    const response = await removal;
    expect(stateBeforeRelease).toBe('waiting');
    expect(response.statusCode).toBe(200);
    expect(
      await db.select().from(assetPlacements).where(eq(assetPlacements.assetId, assetId)),
    ).toEqual([expect.objectContaining({ folderId: secondFolderId })]);
    expect(
      await db
        .select()
        .from(assetReferences)
        .where(
          and(eq(assetReferences.galleryItemId, assetId), eq(assetReferences.refType, 'keep')),
        ),
    ).toHaveLength(1);
  });

  it('counts media room membership rather than asset provenance', async () => {
    const originProjectId = await createProject('Происхождение');
    const memberProjectId = await createProject('Комната');
    const assetId = nid();
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      originProjectId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
    });
    await db.insert(projectAssets).values({ projectId: memberProjectId, assetId, userId });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${memberProjectId}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { rooms: { assets: number } }).rooms.assets).toBe(1);
  });

  it('does not count or attach soft-deleted assets', async () => {
    const projectId = await createProject('Живые материалы');
    const liveId = nid();
    const deletedInProjectId = nid();
    const deletedUnattachedId = nid();
    await db.insert(galleryItems).values([
      {
        id: liveId,
        userId,
        originProjectId: projectId,
        assetUrl: `https://assets.seed.test/${liveId}.png`,
        kind: 'image',
      },
      {
        id: deletedInProjectId,
        userId,
        originProjectId: projectId,
        assetUrl: `https://assets.seed.test/${deletedInProjectId}.png`,
        kind: 'image',
        deletedAt: new Date(),
      },
      {
        id: deletedUnattachedId,
        userId,
        assetUrl: `https://assets.seed.test/${deletedUnattachedId}.png`,
        kind: 'image',
        deletedAt: new Date(),
      },
    ]);
    await db.insert(projectAssets).values([
      { projectId, assetId: liveId, userId },
      { projectId, assetId: deletedInProjectId, userId },
    ]);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}`,
      headers: headers(),
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { rooms: { assets: number } }).rooms.assets).toBe(1);

    const attach = await app.inject({
      method: 'POST',
      url: '/v1/projects/attach',
      headers: headers(),
      payload: {
        projectId,
        resources: [{ type: 'asset', id: deletedUnattachedId }],
      },
    });
    expect(attach.statusCode).toBe(404);
    const [unchanged] = await db
      .select({ projectId: galleryItems.originProjectId })
      .from(galleryItems)
      .where(eq(galleryItems.id, deletedUnattachedId));
    expect(unchanged?.projectId).toBeNull();
  });

  it('a GET never inserts a project', async () => {
    const before = await db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.userId, userId));
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${nid()}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(404);
    const after = await db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.userId, userId));
    expect(after[0]?.value).toBe(before[0]?.value);
  });

  it('soft-deleted projects disappear from list and direct reads', async () => {
    const projectId = await createProject('Удалить');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: headers(),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      ok: true,
      alreadyTrashed: false,
      retentionDays: 30,
    });
    expect(
      (await app.inject({ method: 'GET', url: `/v1/projects/${projectId}`, headers: headers() }))
        .statusCode,
    ).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/v1/projects', headers: headers() });
    expect(
      (list.json() as { items: Array<{ id: string }> }).items.some((item) => item.id === projectId),
    ).toBe(false);
  });

  it('retains project structure and memberships, lists it in Trash, and restores it', async () => {
    const projectId = await createProject('Полный возврат');
    const scriptId = nid();
    const boardId = nid();
    const studioId = nid();
    const assetId = nid();
    await db.insert(scripts).values({
      id: scriptId,
      userId,
      projectId,
      title: 'Сценарий',
    });
    await db.insert(boards).values({
      id: boardId,
      userId,
      projectId,
      title: 'Доска',
      state: {},
    });
    await db.insert(studioProjects).values({
      id: studioId,
      userId,
      projectId,
      title: 'Монтаж',
      timeline: {},
    });
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      originProjectId: projectId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
    });
    await db.insert(projectAssets).values({ projectId, assetId, userId });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: headers(),
    });
    expect(deleted.statusCode).toBe(200);
    const deletion = deleted.json() as { deletedAt: string; purgeAfter: string };
    expect(new Date(deletion.purgeAfter).getTime() - new Date(deletion.deletedAt).getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );

    expect(
      await db
        .select()
        .from(scripts)
        .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, projectId))),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(boards)
        .where(and(eq(boards.id, boardId), eq(boards.projectId, projectId))),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(studioProjects)
        .where(and(eq(studioProjects.id, studioId), eq(studioProjects.projectId, projectId))),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(projectAssets)
        .where(and(eq(projectAssets.projectId, projectId), eq(projectAssets.assetId, assetId))),
    ).toHaveLength(1);

    const trash = await app.inject({
      method: 'GET',
      url: '/v1/projects/trash',
      headers: headers(),
    });
    expect(trash.statusCode).toBe(200);
    expect(trash.json()).toMatchObject({
      retentionDays: 30,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: projectId,
          rooms: { scenario: 1, boards: 1, studio: 1, assets: 1 },
        }),
      ]),
    });
    const inspection = await app.inject({
      method: 'GET',
      url: `/v1/projects/trash/${projectId}`,
      headers: headers(),
    });
    expect(inspection.statusCode).toBe(200);
    expect(inspection.json()).toMatchObject({
      recovery: {
        expected: { scripts: 1, boards: 1, studio: 1, media: 1 },
        restored: { scripts: 1, boards: 1, studio: 1, media: 1 },
        unavailable: { scripts: 0, boards: 0, studio: 0, media: 0 },
        partial: false,
      },
    });

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/restore`,
      headers: headers(),
      payload: {},
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      ok: true,
      project: { id: projectId, title: 'Полный возврат' },
      message: 'restored',
      recovery: { partial: false },
    });
    expect(
      (await app.inject({ method: 'GET', url: `/v1/projects/${projectId}`, headers: headers() }))
        .statusCode,
    ).toBe(200);
  });

  it('reports independently unavailable media as a partial restoration', async () => {
    const projectId = await createProject('Частичный возврат');
    const assetId = nid();
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
    });
    await db.insert(projectAssets).values({ projectId, assetId, userId });
    await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: headers(),
    });
    await db.delete(galleryItems).where(eq(galleryItems.id, assetId));

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/restore`,
      headers: headers(),
      payload: {},
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      message: 'restored_partially',
      recovery: {
        partial: true,
        expected: { media: 1 },
        restored: { media: 0 },
        unavailable: { media: 1 },
      },
    });
  });

  it('requires an explicit collision-free title when restoring', async () => {
    const trashedId = await createProject('Одинаковое имя');
    await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${trashedId}`,
      headers: headers(),
    });
    await createProject('Одинаковое имя');

    const collision = await app.inject({
      method: 'POST',
      url: `/v1/projects/${trashedId}/restore`,
      headers: headers(),
      payload: {},
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({
      error: 'name_collision',
      title: 'Одинаковое имя',
      suggestedTitle: 'Одинаковое имя (восстановлен)',
    });

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/projects/${trashedId}/restore`,
      headers: headers(),
      payload: { title: 'Одинаковое имя — архив' },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      project: { id: trashedId, title: 'Одинаковое имя — архив' },
    });
  });

  it('refuses restore after the documented retention deadline', async () => {
    const projectId = await createProject('Просроченный');
    await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: headers(),
    });
    await db
      .update(projects)
      .set({ purgeAfter: new Date(Date.now() - 1_000) })
      .where(eq(projects.id, projectId));
    const restored = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/restore`,
      headers: headers(),
      payload: {},
    });
    expect(restored.statusCode).toBe(410);
    expect(restored.json()).toMatchObject({ error: 'retention_expired' });
  });

  it('rechecks the retention deadline after waiting for the project lock', async () => {
    const projectId = await createProject('Граница срока');
    await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: headers(),
    });
    const purgeAfter = new Date(Date.now() + 1_000);
    await db.update(projects).set({ purgeAfter }).where(eq(projects.id, projectId));

    let markLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      markLockAcquired = resolve;
    });
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`);
      markLockAcquired();
      await holderReleased;
    });
    await lockAcquired;

    const restore = app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/restore`,
      headers: headers(),
      payload: {},
    });
    const stateBeforeDeadline = await Promise.race([
      restore.then(() => 'settled' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ]);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, purgeAfter.getTime() - Date.now() + 200)),
    );
    releaseHolder();
    await holder;

    const response = await restore;
    expect(stateBeforeDeadline).toBe('waiting');
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: 'retention_expired' });
    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toEqual([
      expect.objectContaining({ deletedAt: expect.any(Date), purgeAfter }),
    ]);
  });

  it('uses the restore transaction connection for recovery inspection', async () => {
    const projectId = await createProject('Единый снимок восстановления');
    await db.insert(scripts).values({
      id: nid(),
      userId,
      projectId,
      title: 'Сценарий в снимке',
    });
    await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: headers(),
    });

    const heldClients = await Promise.all(
      Array.from({ length: Math.max(0, pool.options.max - 1) }, () => pool.connect()),
    );
    const restore = app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/restore`,
      headers: headers(),
      payload: {},
    });
    const stateWithPoolExhausted = await Promise.race([
      restore.then(() => 'settled' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 1_000)),
    ]);
    for (const client of heldClients) client.release();

    const response = await restore;
    expect(stateWithPoolExhausted).toBe('settled');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recovery: {
        expected: { scripts: 1 },
        restored: { scripts: 1 },
        unavailable: { scripts: 0 },
      },
    });
  });

  it('requires the exact project title before permanent deletion', async () => {
    const projectId = await createProject('Удалить навсегда');
    const boardId = nid();
    await db.insert(boards).values({
      id: boardId,
      userId,
      projectId,
      title: 'Сохранённая доска',
      state: {},
    });
    await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: headers(),
    });

    const weak = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}/permanent`,
      headers: headers(),
      payload: { confirmation: 'удалить' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toEqual({ error: 'confirmation_mismatch' });
    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toHaveLength(1);

    const confirmed = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}/permanent`,
      headers: headers(),
      payload: { confirmation: 'Удалить навсегда' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ ok: true, permanentlyDeleted: true });
    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toHaveLength(0);
    const [detachedBoard] = await db.select().from(boards).where(eq(boards.id, boardId));
    expect(detachedBoard?.projectId).toBeNull();
  });

  it('keeps foreign projects invisible to read, rename, and delete lifecycle actions', async () => {
    const foreignUserId = nid();
    const foreignProjectId = nid();
    await db
      .insert(usersApp)
      .values({ id: foreignUserId, displayName: 'Foreign owner', locale: 'ru' });
    await db
      .insert(usersPii)
      .values({ id: foreignUserId, email: `sreda-foreign+${foreignUserId}@seed.local` });
    await db
      .insert(projects)
      .values({ id: foreignProjectId, userId: foreignUserId, title: 'Чужой проект' });

    try {
      const requests = [
        app.inject({
          method: 'GET',
          url: `/v1/projects/${foreignProjectId}`,
          headers: headers(),
        }),
        app.inject({
          method: 'PATCH',
          url: `/v1/projects/${foreignProjectId}`,
          headers: headers(),
          payload: { title: 'Попытка переименовать' },
        }),
        app.inject({
          method: 'DELETE',
          url: `/v1/projects/${foreignProjectId}`,
          headers: headers(),
        }),
      ];
      for (const response of await Promise.all(requests)) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'not_found' });
      }
      const [unchanged] = await db
        .select({ title: projects.title, deletedAt: projects.deletedAt })
        .from(projects)
        .where(eq(projects.id, foreignProjectId));
      expect(unchanged).toEqual({ title: 'Чужой проект', deletedAt: null });

      const deletedAt = new Date();
      await db
        .update(projects)
        .set({
          deletedAt,
          purgeAfter: new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
          trashManifest: { version: 1, scripts: [], boards: [], studio: [], assets: [] },
        })
        .where(eq(projects.id, foreignProjectId));
      const trash = await app.inject({
        method: 'GET',
        url: '/v1/projects/trash',
        headers: headers(),
      });
      expect(
        (trash.json() as { items: Array<{ id: string }> }).items.some(
          (item) => item.id === foreignProjectId,
        ),
      ).toBe(false);
      for (const response of await Promise.all([
        app.inject({
          method: 'GET',
          url: `/v1/projects/trash/${foreignProjectId}`,
          headers: headers(),
        }),
        app.inject({
          method: 'POST',
          url: `/v1/projects/${foreignProjectId}/restore`,
          headers: headers(),
          payload: {},
        }),
        app.inject({
          method: 'DELETE',
          url: `/v1/projects/${foreignProjectId}/permanent`,
          headers: headers(),
          payload: { confirmation: 'Чужой проект' },
        }),
      ])) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'not_found' });
      }
    } finally {
      await db.delete(projects).where(eq(projects.id, foreignProjectId));
      await db.delete(usersPii).where(eq(usersPii.id, foreignUserId));
      await db.delete(usersApp).where(eq(usersApp.id, foreignUserId));
    }
  });

  it('lists projects by most recently updated first', async () => {
    const olderId = await createProject('Старый');
    const newerId = await createProject('Новый');
    await db
      .update(projects)
      .set({ updatedAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(projects.id, olderId));
    await db
      .update(projects)
      .set({ updatedAt: new Date('2026-02-01T00:00:00.000Z') })
      .where(eq(projects.id, newerId));
    const response = await app.inject({ method: 'GET', url: '/v1/projects', headers: headers() });
    const ids = (response.json() as { items: Array<{ id: string }> }).items.map((item) => item.id);
    expect(ids.indexOf(newerId)).toBeLessThan(ids.indexOf(olderId));
  });

  it('renders provenance labels for generated and studio-rendered project recents', async () => {
    const projectId = nid();
    await db.insert(projects).values({ id: projectId, userId, title: 'Источники' });
    const generationId = nid();
    const studioId = nid();
    await db.insert(galleryItems).values([
      {
        id: generationId,
        userId,
        assetUrl: `https://assets.seed.test/${generationId}.png`,
        kind: 'image',
        sourceKind: 'generation',
      },
      {
        id: studioId,
        userId,
        assetUrl: `https://assets.seed.test/${studioId}.mp4`,
        kind: 'video',
        sourceKind: 'studio_render',
      },
    ]);
    await db.insert(projectAssets).values([
      { projectId, assetId: generationId, userId },
      { projectId, assetId: studioId, userId },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/recents`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    const items = (response.json() as { items: Array<{ id: string; sourceLine: string }> }).items;
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: generationId, sourceLine: 'из Генерации' }),
        expect.objectContaining({ id: studioId, sourceLine: 'из Студии' }),
      ]),
    );
  });
});
