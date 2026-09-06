import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import {
  assetPlacements,
  boards,
  db,
  deskIconPositions,
  folders,
  galleryItems,
  nid,
  pool,
  projectAssets,
  projects,
  scripts,
  studioProjects,
  usersApp,
} from '@seed/db';
import { setupDeskRoutes } from '../src/desk';

let app: ReturnType<typeof Fastify>;
const userId = `desk-owner-${nid()}`;
const otherUserId = `desk-other-${nid()}`;
const projectIds: string[] = [];
const assetIds: string[] = [];

const headers = (id = userId) => ({ 'x-test-user': id });

async function makeProject(ownerId = userId, title = 'Проект'): Promise<string> {
  const id = `desk-project-${nid()}`;
  projectIds.push(id);
  await db.insert(projects).values({ id, userId: ownerId, title });
  return id;
}

async function makeAsset(ownerId = userId): Promise<string> {
  const id = `desk-asset-${nid()}`;
  assetIds.push(id);
  await db.insert(galleryItems).values({
    id,
    userId: ownerId,
    assetUrl: `https://assets.seed.test/${id}.png`,
    kind: 'image',
    sourceKind: 'upload',
    expiresAt: ownerId === userId ? new Date(Date.now() + 60_000) : null,
  });
  return id;
}

beforeAll(async () => {
  await db.insert(usersApp).values([
    { id: userId, tier: 'free' },
    { id: otherUserId, tier: 'studio' },
  ]);
  app = Fastify({ logger: false });
  setupDeskRoutes(app, async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.headers['x-test-user'];
    if (typeof id !== 'string') {
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return { user: { id } };
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (projectIds.length > 0) {
    await db.delete(deskIconPositions).where(inArray(deskIconPositions.projectId, projectIds));
  }
  if (assetIds.length > 0) {
    await db.delete(assetPlacements).where(inArray(assetPlacements.assetId, assetIds));
    await db.delete(galleryItems).where(inArray(galleryItems.id, assetIds));
  }
  await db.delete(projects).where(inArray(projects.id, projectIds));
  await db.delete(usersApp).where(inArray(usersApp.id, [userId, otherUserId]));
  await pool.end();
});

describe('project desk layout', () => {
  it('persists a final batch per owner, project, and stable item identity', async () => {
    const projectId = await makeProject();
    const folderId = `desk-folder-${nid()}`;
    await db.insert(folders).values({ id: folderId, projectId, userId, name: 'Раскладка' });

    const first = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 1,
        positions: [
          { itemKind: 'system', itemId: 'recents', x: 0, y: 0 },
          { itemKind: 'folder', itemId: folderId, x: 126, y: 136 },
        ],
      },
    });
    expect(first.statusCode).toBe(200);

    const final = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 2,
        positions: [{ itemKind: 'folder', itemId: folderId, x: 252, y: 0 }],
      },
    });
    expect(final.statusCode).toBe(200);

    const restored = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      revision: 2,
      positions: expect.arrayContaining([
        expect.objectContaining({ itemKind: 'system', itemId: 'recents', x: 0, y: 0 }),
        expect.objectContaining({ itemKind: 'folder', itemId: folderId, x: 252, y: 0 }),
      ]),
    });
  });

  it('keeps the highest revision when layout writes complete out of order', async () => {
    const projectId = await makeProject();

    const final = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 12,
        positions: [{ itemKind: 'system', itemId: 'frames', x: 252, y: 136 }],
      },
    });
    expect(final.statusCode).toBe(200);

    const stale = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 11,
        positions: [{ itemKind: 'system', itemId: 'frames', x: 0, y: 0 }],
      },
    });
    expect(stale.statusCode).toBe(200);

    const restored = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
    });
    expect(restored.json()).toMatchObject({
      revision: 12,
      positions: [
        expect.objectContaining({
          itemKind: 'system',
          itemId: 'frames',
          x: 252,
          y: 136,
        }),
      ],
    });
  });

  it('rejects a raced layout revision without partially writing it, then recovers', async () => {
    const projectId = await makeProject();

    const first = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 8,
        positions: [{ itemKind: 'system', itemId: 'frames', x: 252, y: 136 }],
      },
    });
    expect(first.statusCode).toBe(200);

    const raced = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 8,
        positions: [
          { itemKind: 'system', itemId: 'frames', x: 0, y: 0 },
          { itemKind: 'system', itemId: 'recents', x: 126, y: 0 },
        ],
      },
    });
    expect(raced.statusCode).toBe(409);
    expect(raced.json()).toEqual({ error: 'layout_rev_conflict', revision: 8 });

    const afterConflict = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
    });
    expect(afterConflict.json()).toMatchObject({
      revision: 8,
      positions: [
        expect.objectContaining({ itemKind: 'system', itemId: 'frames', x: 252, y: 136 }),
      ],
    });
    expect(afterConflict.json().positions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemKind: 'system', itemId: 'recents' })]),
    );

    const recovery = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 9,
        positions: [
          { itemKind: 'system', itemId: 'frames', x: 0, y: 0 },
          { itemKind: 'system', itemId: 'recents', x: 126, y: 0 },
        ],
      },
    });
    expect(recovery.statusCode).toBe(200);

    const restored = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
    });
    expect(restored.json()).toMatchObject({
      revision: 9,
      positions: expect.arrayContaining([
        expect.objectContaining({ itemKind: 'system', itemId: 'frames', x: 0, y: 0 }),
        expect.objectContaining({ itemKind: 'system', itemId: 'recents', x: 126, y: 0 }),
      ]),
    });
  });

  it('rejects malformed, duplicate, stale, and cross-project identities atomically', async () => {
    const projectId = await makeProject();
    const otherProjectId = await makeProject();
    const otherFolderId = `desk-folder-${nid()}`;
    await db
      .insert(folders)
      .values({ id: otherFolderId, projectId: otherProjectId, userId, name: 'Другой стол' });

    const malformed = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 1,
        positions: [{ itemKind: 'folder', itemId: 'x', x: -1, y: 0 }],
      },
    });
    expect(malformed.statusCode).toBe(400);

    const duplicate = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 1,
        positions: [
          { itemKind: 'system', itemId: 'frames', x: 0, y: 0 },
          { itemKind: 'system', itemId: 'frames', x: 126, y: 0 },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);

    const crossProject = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/desk-layout`,
      headers: headers(),
      payload: {
        revision: 1,
        positions: [{ itemKind: 'folder', itemId: otherFolderId, x: 0, y: 0 }],
      },
    });
    expect(crossProject.statusCode).toBe(409);
    expect(crossProject.json()).toEqual({
      error: 'invalid_layout_items',
      items: [`folder:${otherFolderId}`],
    });

    const rows = await db
      .select()
      .from(deskIconPositions)
      .where(eq(deskIconPositions.projectId, projectId));
    expect(rows).toEqual([]);
  });

  it('does not expose or accept writes to another user project', async () => {
    const foreignProjectId = await makeProject(otherUserId);
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: `/v1/projects/${foreignProjectId}/desk-layout`,
        headers: headers(),
        ...(method === 'PUT'
          ? {
              payload: {
                revision: 1,
                positions: [{ itemKind: 'system', itemId: 'frames', x: 0, y: 0 }],
              },
            }
          : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });
    }
  });
});

describe('project desk items', () => {
  it('uses a project-scoped placement anti-join for loose media', async () => {
    const projectA = await makeProject(userId, 'А');
    const projectB = await makeProject(userId, 'Б');
    const assetId = await makeAsset();
    const folderId = `desk-folder-${nid()}`;
    await db.insert(projectAssets).values([
      { projectId: projectA, assetId, userId },
      { projectId: projectB, assetId, userId },
    ]);
    await db.insert(folders).values({ id: folderId, projectId: projectA, userId, name: 'В А' });
    await db.insert(assetPlacements).values({ assetId, folderId });

    const [responseA, responseB] = await Promise.all([
      app.inject({ method: 'GET', url: `/v1/projects/${projectA}/desk-items`, headers: headers() }),
      app.inject({ method: 'GET', url: `/v1/projects/${projectB}/desk-items`, headers: headers() }),
    ]);
    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);
    expect((responseA.json() as { items: Array<{ id: string }> }).items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assetId })]),
    );
    expect(responseB.json()).toMatchObject({
      items: [expect.objectContaining({ type: 'media', id: assetId })],
      retention: {
        mode: 'expiring',
        reminder: 'Хранится 30 дней · Скачать · Оставить навсегда → тариф',
      },
    });
  });

  it('returns only user- and project-scoped documents in the surface and app lists', async () => {
    const projectId = await makeProject(userId, 'Рабочий');
    const otherProjectId = await makeProject(userId, 'Другой');
    const foreignProjectId = await makeProject(otherUserId, 'Чужой');
    const scriptId = `desk-script-${nid()}`;
    const boardId = `desk-board-${nid()}`;
    const studioId = `desk-studio-${nid()}`;
    await db.insert(scripts).values([
      { id: scriptId, userId, projectId, title: 'Сценарий проекта' },
      { id: `desk-script-${nid()}`, userId, projectId: otherProjectId, title: 'Другой' },
      {
        id: `desk-script-${nid()}`,
        userId: otherUserId,
        projectId: foreignProjectId,
        title: 'Чужой',
      },
    ]);
    await db.insert(boards).values([
      { id: boardId, userId, projectId, title: 'Борд проекта' },
      { id: `desk-board-${nid()}`, userId, projectId: otherProjectId, title: 'Другой' },
    ]);
    await db.insert(studioProjects).values([
      { id: studioId, userId, projectId, title: 'Монтаж проекта', timeline: {} },
      {
        id: `desk-studio-${nid()}`,
        userId,
        projectId: otherProjectId,
        title: 'Другой',
        timeline: {},
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/desk-items`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ type: string; id: string }>;
      apps: Record<string, Array<{ id: string; href: string }>>;
    };
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'script', id: scriptId }),
        expect.objectContaining({ type: 'board', id: boardId }),
        expect.objectContaining({ type: 'studio', id: studioId }),
      ]),
    );
    expect(body.items).toHaveLength(3);
    expect(body.apps).toEqual({
      scenario: [expect.objectContaining({ id: scriptId, href: `/scenario/${scriptId}` })],
      boards: [expect.objectContaining({ id: boardId, href: `/boards/${boardId}` })],
      studio: [expect.objectContaining({ id: studioId, href: `/studio/${studioId}` })],
    });
  });

  it('does not disclose another user or a soft-deleted project', async () => {
    const foreignProjectId = await makeProject(otherUserId, 'Чужой');
    const deletedProjectId = await makeProject(userId, 'Удалённый');
    await db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(eq(projects.id, deletedProjectId));

    for (const projectId of [foreignProjectId, deletedProjectId]) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/desk-items`,
        headers: headers(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('serves a project member to the full-screen viewer without exposing other projects', async () => {
    const projectId = await makeProject(userId, 'Просмотр');
    const otherProjectId = await makeProject(userId, 'Не тот проект');
    const assetId = await makeAsset();
    await db.insert(projectAssets).values({ projectId, assetId, userId });

    const [member, unrelated] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/media/${assetId}`,
        headers: headers(),
      }),
      app.inject({
        method: 'GET',
        url: `/v1/projects/${otherProjectId}/media/${assetId}`,
        headers: headers(),
      }),
    ]);

    expect(member.statusCode).toBe(200);
    expect(member.json()).toMatchObject({
      asset: { id: assetId, kind: 'image', sourceLine: 'загрузка' },
    });
    expect(Object.keys((member.json() as { asset: object }).asset).sort()).toEqual(
      [
        'assetUrl',
        'id',
        'kind',
        'mimeType',
        'originalName',
        'sourceLine',
        'thumbnailUrl',
        'title',
      ].sort(),
    );
    expect(unrelated.statusCode).toBe(404);
    expect(unrelated.json()).toEqual({ error: 'not_found' });
  });

  it('returns lean desk media and explicit cap+1 truncation for all four sources', async () => {
    const projectId = await makeProject(userId, 'Большой проект');
    const count = 501;
    const now = new Date();
    const mediaIds = Array.from({ length: count }, () => `desk-cap-asset-${nid()}`);
    assetIds.push(...mediaIds);
    await db.insert(galleryItems).values(
      mediaIds.map((id, index) => ({
        id,
        userId,
        assetUrl: `https://assets.seed.test/${id}.png`,
        thumbnailUrl: `https://assets.seed.test/${id}-thumb.png`,
        kind: 'image' as const,
        sourceKind: 'generation' as const,
        title: `Медиа ${index}`,
        originalName: `${id}.png`,
        mimeType: 'image/png',
        checksum: `checksum-${id}`,
        sizeBytes: 123,
        expiresAt: new Date(now.getTime() + 60_000),
      })),
    );
    await db
      .insert(projectAssets)
      .values(mediaIds.map((assetId) => ({ projectId, assetId, userId })));
    await db.insert(scripts).values(
      Array.from({ length: count }, (_, index) => ({
        id: `desk-cap-script-${nid()}`,
        userId,
        projectId,
        title: `Сценарий ${index}`,
      })),
    );
    await db.insert(boards).values(
      Array.from({ length: count }, (_, index) => ({
        id: `desk-cap-board-${nid()}`,
        userId,
        projectId,
        title: `Борд ${index}`,
      })),
    );
    await db.insert(studioProjects).values(
      Array.from({ length: count }, (_, index) => ({
        id: `desk-cap-studio-${nid()}`,
        userId,
        projectId,
        title: `Студия ${index}`,
        timeline: {},
      })),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/desk-items`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ type: string; asset?: Record<string, unknown> }>;
      apps: { scenario: unknown[]; boards: unknown[]; studio: unknown[] };
      truncated: Record<string, boolean>;
    };
    expect(body.items.filter((item) => item.type === 'media')).toHaveLength(500);
    expect(body.apps.scenario).toHaveLength(500);
    expect(body.apps.boards).toHaveLength(500);
    expect(body.apps.studio).toHaveLength(500);
    expect(body.truncated).toEqual({ media: true, scenario: true, boards: true, studio: true });
    const asset = body.items.find((item) => item.type === 'media')!.asset!;
    expect(Object.keys(asset).sort()).toEqual(
      [
        'assetUrl',
        'id',
        'kind',
        'mimeType',
        'originalName',
        'sourceLine',
        'thumbnailUrl',
        'title',
      ].sort(),
    );
    for (const forbidden of [
      'checksum',
      'sizeBytes',
      'isPublic',
      'publicSlug',
      'featuredAt',
      'promptVisible',
      'folder',
      'expiresAt',
      'deletedAt',
      'sourceKind',
    ]) {
      expect(asset).not.toHaveProperty(forbidden);
    }
  });
});
