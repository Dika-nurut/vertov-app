import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import {
  boards,
  db,
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
import { setupBoardRoutes } from '../src/boards';
import { setupGalleryRoutes } from '../src/gallery';
import { setupScriptRoutes } from '../src/scripts';
import { setupStudioRoutes } from '../src/studio';
import { setupDeskRoutes } from '../src/desk';

let app: ReturnType<typeof Fastify>;
let ownerId: string;
let foreignUserId: string;
let firstProjectId: string;
let secondProjectId: string;
let deletedProjectId: string;
let foreignProjectId: string;
let standaloneScriptId: string;
let scopedScriptId: string;
let standaloneBoardId: string;
let scopedBoardId: string;
let standaloneStudioProjectId: string;
let scopedStudioProjectId: string;
let firstMemberAssetId: string;
let provenanceOnlyAssetId: string;

async function insertUser(id: string, label: string) {
  await db.insert(usersApp).values({ id, displayName: label, locale: 'ru' });
  await db
    .insert(usersPii)
    .values({ id, email: `project-context+${label}-${id}@seed.local`.toLowerCase() });
}

beforeAll(async () => {
  ownerId = nid();
  foreignUserId = nid();
  await insertUser(ownerId, 'Owner');
  await insertUser(foreignUserId, 'Foreign');

  firstProjectId = nid();
  secondProjectId = nid();
  deletedProjectId = nid();
  foreignProjectId = nid();
  await db.insert(projects).values([
    { id: firstProjectId, userId: ownerId, title: 'Первый контекст' },
    { id: secondProjectId, userId: ownerId, title: 'Второй контекст' },
    {
      id: deletedProjectId,
      userId: ownerId,
      title: 'Удалённый контекст',
      deletedAt: new Date(),
    },
    { id: foreignProjectId, userId: foreignUserId, title: 'Чужой контекст' },
  ]);

  standaloneScriptId = nid();
  scopedScriptId = nid();
  standaloneBoardId = nid();
  scopedBoardId = nid();
  standaloneStudioProjectId = nid();
  scopedStudioProjectId = nid();
  await db.insert(scripts).values([
    { id: standaloneScriptId, userId: ownerId, title: 'Самостоятельный сценарий' },
    {
      id: scopedScriptId,
      userId: ownerId,
      projectId: firstProjectId,
      title: 'Сценарий проекта',
    },
  ]);
  await db.insert(boards).values([
    { id: standaloneBoardId, userId: ownerId, title: 'Самостоятельный борд', state: {} },
    {
      id: scopedBoardId,
      userId: ownerId,
      projectId: firstProjectId,
      title: 'Борд проекта',
      state: {},
    },
  ]);
  await db.insert(studioProjects).values([
    {
      id: standaloneStudioProjectId,
      userId: ownerId,
      title: 'Самостоятельный монтаж',
      timeline: {},
    },
    {
      id: scopedStudioProjectId,
      userId: ownerId,
      projectId: firstProjectId,
      title: 'Монтаж проекта',
      timeline: {},
    },
  ]);

  firstMemberAssetId = nid();
  provenanceOnlyAssetId = nid();
  await db.insert(galleryItems).values([
    {
      id: firstMemberAssetId,
      userId: ownerId,
      originProjectId: secondProjectId,
      assetUrl: `https://assets.seed.test/${firstMemberAssetId}.png`,
      kind: 'image',
      folder: 'В проекте',
      tags: ['member'],
    },
    {
      id: provenanceOnlyAssetId,
      userId: ownerId,
      originProjectId: firstProjectId,
      assetUrl: `https://assets.seed.test/${provenanceOnlyAssetId}.png`,
      kind: 'image',
      folder: 'Только происхождение',
      tags: ['origin'],
    },
  ]);
  await db
    .insert(projectAssets)
    .values({ projectId: firstProjectId, assetId: firstMemberAssetId, userId: ownerId });

  app = Fastify({ logger: false });
  const requireSession = async () => ({ user: { id: ownerId } });
  setupScriptRoutes(app, requireSession);
  setupBoardRoutes(app, requireSession);
  setupStudioRoutes(app, requireSession);
  setupGalleryRoutes(app, requireSession);
  setupDeskRoutes(app, requireSession);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.delete(projectAssets).where(inArray(projectAssets.userId, [ownerId, foreignUserId]));
  await db.delete(galleryItems).where(inArray(galleryItems.userId, [ownerId, foreignUserId]));
  await db.delete(studioProjects).where(inArray(studioProjects.userId, [ownerId, foreignUserId]));
  await db.delete(boards).where(inArray(boards.userId, [ownerId, foreignUserId]));
  await db.delete(scripts).where(inArray(scripts.userId, [ownerId, foreignUserId]));
  await db.delete(projects).where(inArray(projects.userId, [ownerId, foreignUserId]));
  await db.delete(usersPii).where(inArray(usersPii.id, [ownerId, foreignUserId]));
  await db.delete(usersApp).where(inArray(usersApp.id, [ownerId, foreignUserId]));
  await pool.end();
});

async function listIds(url: string, key: 'items' | 'rows' = 'items'): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode).toBe(200);
  return (response.json() as Record<string, Array<{ id: string }>>)[key]!.map((row) => row.id);
}

describe('shared owned live project context', () => {
  it('keeps standalone lists unchanged and scopes all product lists when requested', async () => {
    expect(await listIds('/v1/scripts')).toEqual(
      expect.arrayContaining([standaloneScriptId, scopedScriptId]),
    );
    expect(await listIds('/v1/boards')).toEqual(
      expect.arrayContaining([standaloneBoardId, scopedBoardId]),
    );
    expect(await listIds('/v1/studio/projects')).toEqual(
      expect.arrayContaining([standaloneStudioProjectId, scopedStudioProjectId]),
    );

    expect(await listIds(`/v1/scripts?projectId=${firstProjectId}`)).toEqual([scopedScriptId]);
    expect(await listIds(`/v1/boards?projectId=${firstProjectId}`)).toEqual([scopedBoardId]);
    expect(await listIds(`/v1/studio/projects?projectId=${firstProjectId}`)).toEqual([
      scopedStudioProjectId,
    ]);
  });

  it('creates scripts, Boards, and named Studio compositions inside the transaction context', async () => {
    const script = await app.inject({
      method: 'POST',
      url: '/v1/scripts',
      payload: { title: 'Новый сценарий проекта', projectId: firstProjectId },
    });
    const board = await app.inject({
      method: 'POST',
      url: '/v1/boards',
      payload: { title: 'Новый борд проекта', projectId: firstProjectId },
    });
    const studio = await app.inject({
      method: 'POST',
      url: '/v1/studio/projects',
      payload: { title: 'Новый монтаж проекта', projectId: firstProjectId },
    });
    for (const response of [script, board, studio]) expect(response.statusCode).toBe(201);

    const scriptBody = script.json() as { id: string; projectId: string };
    const boardBody = board.json() as { id: string; projectId: string };
    const studioBody = studio.json() as { id: string; projectId: string };
    expect([scriptBody.projectId, boardBody.projectId, studioBody.projectId]).toEqual([
      firstProjectId,
      firstProjectId,
      firstProjectId,
    ]);
    expect(studioBody.id).not.toBe(studioBody.projectId);

    expect(
      (await db.select().from(scripts).where(eq(scripts.id, scriptBody.id)))[0]?.projectId,
    ).toBe(firstProjectId);
    expect((await db.select().from(boards).where(eq(boards.id, boardBody.id)))[0]?.projectId).toBe(
      firstProjectId,
    );
    expect(
      (await db.select().from(studioProjects).where(eq(studioProjects.id, studioBody.id)))[0]
        ?.projectId,
    ).toBe(firstProjectId);
  });

  it('filters Gallery by explicit membership, never provenance', async () => {
    expect(await listIds('/v1/gallery', 'rows')).toEqual(
      expect.arrayContaining([firstMemberAssetId, provenanceOnlyAssetId]),
    );
    expect(await listIds(`/v1/gallery?projectId=${firstProjectId}`, 'rows')).toEqual([
      firstMemberAssetId,
    ]);

    const scopedFolders = await app.inject({
      method: 'GET',
      url: `/v1/gallery/folders?projectId=${firstProjectId}`,
    });
    const scopedTags = await app.inject({
      method: 'GET',
      url: `/v1/gallery/tags?projectId=${firstProjectId}`,
    });
    expect(scopedFolders.statusCode).toBe(200);
    expect(scopedFolders.json()).toEqual([{ folder: 'В проекте', count: 1 }]);
    expect(scopedTags.statusCode).toBe(200);
    expect(scopedTags.json()).toEqual([{ tag: 'member', count: 1 }]);
  });

  it('rejects malformed, deleted, and foreign contexts without falling back', async () => {
    for (const endpoint of [
      '/v1/scripts',
      '/v1/boards',
      '/v1/studio/projects',
      '/v1/gallery',
      '/v1/gallery/folders',
      '/v1/gallery/tags',
    ]) {
      expect((await app.inject({ method: 'GET', url: `${endpoint}?projectId=` })).statusCode).toBe(
        400,
      );
      for (const projectId of [deletedProjectId, foreignProjectId, 'unknown-project']) {
        const response = await app.inject({
          method: 'GET',
          url: `${endpoint}?projectId=${projectId}`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'not_found' });
      }
    }

    const before = await db
      .select({ id: boards.id })
      .from(boards)
      .where(eq(boards.userId, ownerId));
    for (const projectId of [deletedProjectId, foreignProjectId]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/boards',
        payload: { title: 'Не должен появиться', projectId },
      });
      expect(response.statusCode).toBe(404);
    }
    const after = await db.select({ id: boards.id }).from(boards).where(eq(boards.userId, ownerId));
    expect(after).toHaveLength(before.length);
  });

  it('replays script idempotency only in its original project context', async () => {
    const idempotencyKey = `context-${nid()}`;
    const create = (projectId?: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/scripts',
        payload: {
          title: 'Идемпотентный сценарий',
          idempotencyKey,
          ...(projectId && { projectId }),
        },
      });
    const first = await create(firstProjectId);
    const replay = await create(firstProjectId);
    const mismatch = await create(secondProjectId);
    const standaloneMismatch = await create();
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.json().id, projectId: firstProjectId });
    for (const response of [mismatch, standaloneMismatch]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'idempotency_project_mismatch' });
    }
    const [stored] = await db.select().from(scripts).where(eq(scripts.id, first.json().id));
    expect(stored?.projectId).toBe(firstProjectId);
  });

  it('validates matching project context when opening exclusive product resources', async () => {
    for (const [path, id] of [
      ['/v1/scripts', scopedScriptId],
      ['/v1/boards', scopedBoardId],
      ['/v1/studio/projects', scopedStudioProjectId],
    ] as const) {
      const matching = await app.inject({
        method: 'GET',
        url: `${path}/${id}?projectId=${firstProjectId}`,
      });
      const mismatch = await app.inject({
        method: 'GET',
        url: `${path}/${id}?projectId=${secondProjectId}`,
      });
      const malformed = await app.inject({
        method: 'GET',
        url: `${path}/${id}?projectId=`,
      });
      expect(matching.statusCode, matching.body).toBe(200);
      expect(mismatch.statusCode, mismatch.body).toBe(409);
      expect(mismatch.json()).toMatchObject({
        error: 'project_mismatch',
        expectedProjectId: secondProjectId,
        actualProjectId: firstProjectId,
      });
      expect(malformed.statusCode, malformed.body).toBe(400);
    }
  });

  it('scopes the Studio source bin through project membership', async () => {
    const scoped = await app.inject({
      method: 'GET',
      url: `/v1/studio/clips?kind=image&projectId=${firstProjectId}`,
    });
    const standalone = await app.inject({
      method: 'GET',
      url: '/v1/studio/clips?kind=image',
    });
    const legacyVideoFallback = await app.inject({
      method: 'GET',
      url: '/v1/studio/clips?kind=legacy-video-value',
    });
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(scoped.json().clips.map((clip: { id: string }) => clip.id)).toEqual([
      firstMemberAssetId,
    ]);
    expect(standalone.statusCode, standalone.body).toBe(200);
    expect(standalone.json().clips.map((clip: { id: string }) => clip.id)).toEqual(
      expect.arrayContaining([firstMemberAssetId, provenanceOnlyAssetId]),
    );
    expect(legacyVideoFallback.statusCode, legacyVideoFallback.body).toBe(200);
  });

  it('creates project examples and keeps standalone examples standalone', async () => {
    const scoped = await app.inject({
      method: 'POST',
      url: '/v1/scripts/example',
      payload: { projectId: firstProjectId },
    });
    const standalone = await app.inject({
      method: 'POST',
      url: '/v1/scripts/example',
      payload: {},
    });
    expect(scoped.statusCode, scoped.body).toBe(201);
    expect(standalone.statusCode, standalone.body).toBe(201);
    expect(scoped.json().projectId).toBe(firstProjectId);
    expect(standalone.json().projectId).toBeNull();
  });

  it('hands a scoped Scenario to new and existing Boards idempotently', async () => {
    await db
      .update(scripts)
      .set({
        fountain: 'ИНТ. МАСТЕРСКАЯ - ДЕНЬ\n= Первый кадр.\n\nГерой включает свет.\n',
      })
      .where(eq(scripts.id, scopedScriptId));

    const newKey = `scenario-board-${nid()}`;
    const createPayload = {
      ordinals: [1],
      destination: 'new',
      fullSync: true,
      idempotencyKey: newKey,
    };
    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${scopedScriptId}/board-handoff`,
      payload: createPayload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${scopedScriptId}/board-handoff`,
      payload: createPayload,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      boardId: created.json().boardId,
      created: false,
      replayed: true,
    });
    const [inherited] = await db.select().from(boards).where(eq(boards.id, created.json().boardId));
    expect(inherited?.projectId).toBe(firstProjectId);

    const existingBoardId = nid();
    await db.insert(boards).values({
      id: existingBoardId,
      userId: ownerId,
      projectId: firstProjectId,
      title: 'Существующая доска проекта',
      state: {},
    });
    const updateKey = `scenario-board-${nid()}`;
    const updatePayload = {
      ordinals: [1],
      destination: 'board',
      boardId: existingBoardId,
      fullSync: false,
      idempotencyKey: updateKey,
    };
    const updated = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${scopedScriptId}/board-handoff`,
      payload: updatePayload,
    });
    const updateReplay = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${scopedScriptId}/board-handoff`,
      payload: updatePayload,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ boardId: existingBoardId, replayed: false, added: 1 });
    expect(updateReplay.statusCode, updateReplay.body).toBe(200);
    expect(updateReplay.json()).toMatchObject({
      boardId: existingBoardId,
      replayed: true,
      added: 1,
    });
    expect(updateReplay.json().state.__rev).toBe(updated.json().state.__rev);
  });

  it('rejects Scenario to Board project mismatch without a partial write', async () => {
    const mismatchedBoardId = nid();
    const originalState = {
      schemaVersion: 1,
      nodes: [
        {
          id: 'keep-me',
          type: 'note',
          version: 1,
          position: { x: 10, y: 10 },
          data: { text: 'Не менять' },
        },
      ],
      edges: [],
      tray: [],
      __rev: 7,
    };
    await db.insert(boards).values({
      id: mismatchedBoardId,
      userId: ownerId,
      projectId: secondProjectId,
      title: 'Доска другого проекта',
      state: originalState,
    });

    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${scopedScriptId}/board-handoff`,
      payload: {
        ordinals: [1],
        destination: 'board',
        boardId: mismatchedBoardId,
        fullSync: false,
        idempotencyKey: `scenario-board-${nid()}`,
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json()).toEqual({
      error: 'project_mismatch',
      scriptProjectId: firstProjectId,
      boardProjectId: secondProjectId,
    });
    const [stored] = await db.select().from(boards).where(eq(boards.id, mismatchedBoardId));
    expect(stored?.state).toEqual(originalState);
    expect(stored?.projectId).toBe(secondProjectId);
  });

  it('preserves standalone Scenario to new Board behavior', async () => {
    await db
      .update(scripts)
      .set({
        fountain: 'НАТ. ПОЛЕ - НОЧЬ\n= Отдельная сцена.\n\nВетер качает траву.\n',
      })
      .where(eq(scripts.id, standaloneScriptId));
    const response = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${standaloneScriptId}/board-handoff`,
      payload: { ordinals: [1], destination: 'new', fullSync: false },
    });
    expect(response.statusCode, response.body).toBe(201);
    const [stored] = await db.select().from(boards).where(eq(boards.id, response.json().boardId));
    expect(stored?.projectId).toBeNull();
  });

  it('hands a scoped Board to a named Studio composition atomically and idempotently', async () => {
    const clip = {
      uid: 'tl-project-clip',
      url: 'https://assets.seed.test/project-clip.mp4',
      dur: 5,
      inSec: 0,
      outSec: 5,
      speed: 1,
      muted: false,
      volumeDb: 0,
      transition: 'cut',
      transitionSec: 0.5,
      filter: 'none',
    };
    const createPayload = {
      destination: 'new',
      title: 'Монтаж из Доски',
      clips: [clip],
      idempotencyKey: `board-studio-${nid()}`,
    };
    const created = await app.inject({
      method: 'POST',
      url: `/v1/boards/${scopedBoardId}/studio-handoff`,
      payload: createPayload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/boards/${scopedBoardId}/studio-handoff`,
      payload: createPayload,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      workspaceProjectId: firstProjectId,
      created: true,
      replayed: false,
      clipCount: 1,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      studioProjectId: created.json().studioProjectId,
      workspaceProjectId: firstProjectId,
      created: false,
      replayed: true,
    });
    const [createdStudio] = await db
      .select()
      .from(studioProjects)
      .where(eq(studioProjects.id, created.json().studioProjectId));
    expect(createdStudio?.projectId).toBe(firstProjectId);
    expect(createdStudio?.timeline).toMatchObject({
      schemaVersion: 2,
      tracks: [{ clips: [clip] }],
      __boardHandoff: {
        sourceBoardId: scopedBoardId,
        idempotencyKey: createPayload.idempotencyKey,
      },
    });

    const existingPayload = {
      destination: 'studio',
      studioProjectId: scopedStudioProjectId,
      clips: [{ ...clip, uid: 'tl-existing' }],
      idempotencyKey: `board-studio-${nid()}`,
    };
    const updated = await app.inject({
      method: 'POST',
      url: `/v1/boards/${scopedBoardId}/studio-handoff`,
      payload: existingPayload,
    });
    const updatedReplay = await app.inject({
      method: 'POST',
      url: `/v1/boards/${scopedBoardId}/studio-handoff`,
      payload: existingPayload,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      studioProjectId: scopedStudioProjectId,
      created: false,
      replayed: false,
    });
    expect(updatedReplay.statusCode, updatedReplay.body).toBe(200);
    expect(updatedReplay.json()).toMatchObject({
      studioProjectId: scopedStudioProjectId,
      replayed: true,
    });
  });

  it('rolls back Board to Studio mismatches and refuses project work in scratch', async () => {
    const otherStudioId = nid();
    const originalTimeline = { timeline: [], marker: 'unchanged' };
    await db.insert(studioProjects).values({
      id: otherStudioId,
      userId: ownerId,
      projectId: secondProjectId,
      title: 'Монтаж другого проекта',
      timeline: originalTimeline,
    });
    const countBefore = (
      await db
        .select({ id: studioProjects.id })
        .from(studioProjects)
        .where(eq(studioProjects.userId, ownerId))
    ).length;
    const clip = {
      uid: 'tl-rejected',
      url: 'https://assets.seed.test/rejected.mp4',
      dur: 4,
      inSec: 0,
      outSec: 4,
      speed: 1,
      muted: false,
      volumeDb: 0,
      transition: 'cut',
      transitionSec: 0.5,
      filter: 'none',
    };
    const mismatch = await app.inject({
      method: 'POST',
      url: `/v1/boards/${scopedBoardId}/studio-handoff`,
      payload: {
        destination: 'studio',
        studioProjectId: otherStudioId,
        clips: [clip],
        idempotencyKey: `board-studio-${nid()}`,
      },
    });
    const standalone = await app.inject({
      method: 'POST',
      url: `/v1/boards/${standaloneBoardId}/studio-handoff`,
      payload: {
        destination: 'new',
        clips: [clip],
        idempotencyKey: `board-studio-${nid()}`,
      },
    });
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    expect(mismatch.json()).toEqual({
      error: 'project_mismatch',
      boardProjectId: firstProjectId,
      studioProjectId: secondProjectId,
    });
    expect(standalone.statusCode, standalone.body).toBe(409);
    expect(standalone.json()).toEqual({ error: 'board_not_project_scoped' });
    const [unchanged] = await db
      .select()
      .from(studioProjects)
      .where(eq(studioProjects.id, otherStudioId));
    expect(unchanged?.timeline).toEqual(originalTimeline);
    const countAfter = (
      await db
        .select({ id: studioProjects.id })
        .from(studioProjects)
        .where(eq(studioProjects.userId, ownerId))
    ).length;
    expect(countAfter).toBe(countBefore);
  });
});

describe('bounded project overflow retrieval', () => {
  it('keeps the desk bounded and keyset-pages 501+ rows without gaps or cross-project replay', async () => {
    const count = 501;
    const stamp = new Date('2026-07-24T08:00:00.000Z');
    const prefix = `overflow-${ownerId.slice(0, 8)}`;
    const ids = Array.from(
      { length: count },
      (_, index) => `${prefix}-${String(index).padStart(4, '0')}`,
    );
    await db.insert(scripts).values(
      ids.map((id) => ({
        id: `script-${id}`,
        userId: ownerId,
        projectId: secondProjectId,
        title: `Сценарий ${id}`,
        updatedAt: stamp,
      })),
    );
    await db.insert(boards).values(
      ids.map((id) => ({
        id: `board-${id}`,
        userId: ownerId,
        projectId: secondProjectId,
        title: `Доска ${id}`,
        state: {},
        updatedAt: stamp,
      })),
    );
    await db.insert(studioProjects).values(
      ids.map((id) => ({
        id: `studio-${id}`,
        userId: ownerId,
        projectId: secondProjectId,
        title: `Монтаж ${id}`,
        timeline: {},
        updatedAt: stamp,
      })),
    );
    await db.insert(galleryItems).values(
      ids.map((id) => ({
        id: `asset-${id}`,
        userId: ownerId,
        assetUrl: `https://assets.seed.test/${id}.png`,
        kind: 'image' as const,
        createdAt: stamp,
      })),
    );
    await db.insert(projectAssets).values(
      ids.map((id) => ({
        projectId: secondProjectId,
        assetId: `asset-${id}`,
        userId: ownerId,
        addedAt: stamp,
      })),
    );

    const desk = await app.inject({
      method: 'GET',
      url: `/v1/projects/${secondProjectId}/desk-items`,
    });
    expect(desk.statusCode, desk.body).toBe(200);
    const deskBody = desk.json() as {
      items: Array<Record<string, unknown>>;
      apps: { scenario: unknown[]; boards: unknown[]; studio: unknown[] };
      truncated: Record<string, boolean>;
    };
    expect(deskBody.items.filter((item) => item.type === 'media')).toHaveLength(500);
    expect(deskBody.apps.scenario).toHaveLength(500);
    expect(deskBody.apps.boards).toHaveLength(500);
    expect(deskBody.apps.studio).toHaveLength(500);
    expect(deskBody.truncated).toEqual({
      media: true,
      scenario: true,
      boards: true,
      studio: true,
    });
    const media = deskBody.items.find((item) => item.type === 'media')?.asset as Record<
      string,
      unknown
    >;
    expect(Object.keys(media).sort()).toEqual(
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

    async function collect(
      path: '/v1/scripts' | '/v1/boards' | '/v1/studio/projects' | '/v1/gallery',
      key: 'items' | 'rows',
    ) {
      const found: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ projectId: secondProjectId, limit: '73' });
        if (cursor) query.set('cursor', cursor);
        const response = await app.inject({
          method: 'GET',
          url: `${path}?${query.toString()}`,
        });
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json() as {
          items?: Array<{ id: string }>;
          rows?: Array<{ id: string }>;
          nextCursor: string | null;
        };
        found.push(...(body[key] ?? []).map((row) => row.id));
        cursor = body.nextCursor;
      } while (cursor);
      return found;
    }

    for (const [path, key, expectedPrefix] of [
      ['/v1/scripts', 'items', 'script-'],
      ['/v1/boards', 'items', 'board-'],
      ['/v1/studio/projects', 'items', 'studio-'],
      ['/v1/gallery', 'rows', 'asset-'],
    ] as const) {
      const found = await collect(path, key);
      expect(new Set(found).size).toBe(found.length);
      const overflowFound = found.filter((id) => id.startsWith(`${expectedPrefix}${prefix}`));
      expect(overflowFound).toHaveLength(count);
      expect(new Set(overflowFound).size).toBe(count);

      const first = await app.inject({
        method: 'GET',
        url: `${path}?projectId=${secondProjectId}&limit=10`,
      });
      const cursor = (first.json() as { nextCursor: string }).nextCursor;
      const replay = await app.inject({
        method: 'GET',
        url: `${path}?projectId=${firstProjectId}&limit=10&cursor=${encodeURIComponent(cursor)}`,
      });
      expect(replay.statusCode, replay.body).toBe(400);
      expect(replay.json()).toEqual({ error: 'invalid_cursor' });
      const malformed = await app.inject({
        method: 'GET',
        url: `${path}?projectId=${secondProjectId}&cursor=not-a-cursor`,
      });
      expect(malformed.statusCode, malformed.body).toBe(400);
      expect(malformed.json()).toEqual({ error: 'invalid_cursor' });
    }
  }, 30_000);
});
