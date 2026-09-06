import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  assetReferences,
  boardSnapshots,
  boards,
  db,
  galleryItems,
  nid,
  pool,
  usersApp,
  usersPii,
} from '@seed/db';
import { setupBoardRoutes } from '../src/boards';

const users: string[] = [];
const boardsToClean: string[] = [];
let currentUser = '';
let attacker = '';
let app: ReturnType<typeof Fastify>;

async function makeUser(label: string): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: label, locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `boards-hardening+${id}@seed.local` });
  users.push(id);
  return id;
}

const headers = () => ({ 'x-test-user': currentUser });

function withoutRevision(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy.__rev;
  return copy;
}

async function makeBoard(title = 'Безопасный борд'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/boards',
    headers: headers(),
    payload: { title },
  });
  expect(response.statusCode, response.body).toBe(201);
  const id = (response.json() as { id: string }).id;
  boardsToClean.push(id);
  return id;
}

beforeAll(async () => {
  currentUser = await makeUser('Hardening owner');
  attacker = await makeUser('Hardening attacker');
  app = Fastify({ logger: false });
  const requireSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.headers['x-test-user'];
    if (typeof id !== 'string') {
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return { user: { id } };
  };
  setupBoardRoutes(app, requireSession);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (boardsToClean.length) await db.delete(boards).where(inArray(boards.id, boardsToClean));
  if (users.length) {
    await db.delete(usersPii).where(inArray(usersPii.id, users));
    await db.delete(usersApp).where(inArray(usersApp.id, users));
  }
  await pool.end();
});

describe('boards production hardening', () => {
  it('trashes, restores, renames, duplicates, and isolates every action by owner', async () => {
    const id = await makeBoard('Оригинальный борд');
    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      headers: headers(),
      payload: {
        rev: 0,
        state: {
          nodes: [
            { id: 'note', type: 'note', position: { x: 0, y: 0 }, data: { text: 'сохрани' } },
          ],
          edges: [],
        },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/boards/${id}`,
      headers: headers(),
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/boards', headers: headers() })).json().items,
    ).not.toContainEqual(expect.objectContaining({ id }));
    expect(
      (await app.inject({ method: 'GET', url: `/v1/boards/${id}`, headers: headers() })).statusCode,
    ).toBe(404);

    currentUser = attacker;
    for (const attempt of [
      { method: 'POST', url: `/v1/boards/${id}/restore` },
      { method: 'POST', url: `/v1/boards/${id}/duplicate`, payload: {} },
      { method: 'DELETE', url: `/v1/boards/${id}/permanent` },
    ] as const) {
      const response = await app.inject({ ...attempt, headers: headers() });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    currentUser = users[0] ?? '';
    const trash = await app.inject({ method: 'GET', url: '/v1/boards/trash', headers: headers() });
    expect(trash.statusCode).toBe(200);
    expect(trash.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, title: 'Оригинальный борд', purgeAfter: expect.any(String) }),
      ]),
    );

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/boards/${id}/restore`,
      headers: headers(),
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/boards/${id}`,
      headers: headers(),
      payload: { title: 'Переименован' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const copy = await app.inject({
      method: 'POST',
      url: `/v1/boards/${id}/duplicate`,
      headers: headers(),
      payload: {},
    });
    expect(copy.statusCode, copy.body).toBe(201);
    const copyBody = copy.json() as {
      id: string;
      title: string;
      state: Record<string, unknown>;
      shareToken: string | null;
    };
    boardsToClean.push(copyBody.id);
    expect(copyBody.id).not.toBe(id);
    expect(copyBody.title).toBe('Переименован (копия)');
    expect(copyBody.shareToken).toBeNull();
    expect(copyBody.state).toMatchObject({ __rev: 0, nodes: [{ id: 'note' }] });
  });

  it('resets a poisoned document into a loadable board and retains the raw backup', async () => {
    const id = await makeBoard('Повреждённый борд');
    await db
      .update(boards)
      .set({ state: { schemaVersion: 99, nodes: [], edges: [] } })
      .where(eq(boards.id, id));
    const corrupt = await app.inject({
      method: 'GET',
      url: `/v1/boards/${id}`,
      headers: headers(),
    });
    expect(corrupt.statusCode).toBe(409);
    expect(corrupt.json()).toMatchObject({
      error: 'invalid_board_state',
      code: 'BOARD_STATE_INVALID',
      recoveryAvailable: false,
    });
    const missingConfirmation = await app.inject({
      method: 'POST',
      url: `/v1/boards/${id}/reset`,
      headers: headers(),
      payload: {},
    });
    expect(missingConfirmation.statusCode).toBe(400);
    const reset = await app.inject({
      method: 'POST',
      url: `/v1/boards/${id}/reset`,
      headers: headers(),
      payload: { confirmation: true },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const readable = await app.inject({
      method: 'GET',
      url: `/v1/boards/${id}`,
      headers: headers(),
    });
    expect(readable.statusCode, readable.body).toBe(200);
    expect(readable.json().state).toMatchObject({
      schemaVersion: 1,
      nodes: [],
      edges: [],
      tray: [],
    });
    const row = (
      await db.select({ stateBackup: boards.stateBackup }).from(boards).where(eq(boards.id, id))
    ).at(0);
    expect(row?.stateBackup).toMatchObject({ schemaVersion: 99 });
  });

  it('restores the latest server snapshot when the current document is corrupt', async () => {
    const id = await makeBoard('Серверная копия');
    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      headers: headers(),
      payload: {
        rev: 0,
        state: {
          nodes: [
            { id: 'recover-me', type: 'text', position: { x: 0, y: 0 }, data: { text: 'копия' } },
          ],
          edges: [],
        },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await db
      .update(boards)
      .set({ state: { schemaVersion: 99 } })
      .where(eq(boards.id, id));

    const corrupt = await app.inject({
      method: 'GET',
      url: `/v1/boards/${id}`,
      headers: headers(),
    });
    expect(corrupt.statusCode).toBe(409);
    expect(corrupt.json()).toMatchObject({ recoveryAvailable: true });
    const history = await app.inject({
      method: 'GET',
      url: `/v1/boards/${id}/snapshots`,
      headers: headers(),
    });
    const snapshotId = (history.json() as { items: Array<{ id: string }> }).items[0]?.id;
    expect(snapshotId).toEqual(expect.any(String));

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/boards/${id}/snapshots/${snapshotId}/restore`,
      headers: headers(),
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const readable = await app.inject({
      method: 'GET',
      url: `/v1/boards/${id}`,
      headers: headers(),
    });
    expect(readable.statusCode, readable.body).toBe(200);
    expect(readable.json().state.nodes).toEqual([
      expect.objectContaining({
        id: 'recover-me',
        type: 'text',
        data: { text: 'копия', size: 'm' },
      }),
    ]);
  });

  it('exports/imports validated structure, rejects future schema, and keeps history bounded', async () => {
    const id = await makeBoard('Раунд-трип');
    const state = {
      schemaVersion: 1,
      nodes: [
        { id: 'frame', type: 'frame', position: { x: 0, y: 0 }, data: { title: 'Группа' } },
        {
          id: 'text',
          type: 'text',
          position: { x: 10, y: 10 },
          parentId: 'frame',
          extent: 'parent',
          data: { text: 'текст', size: 's' },
        },
        {
          id: 'prompt',
          type: 'prompt',
          position: { x: 600, y: 20 },
          data: { text: 'исходный промпт' },
        },
        {
          id: 'generate',
          type: 'generate',
          position: { x: 920, y: 20 },
          data: { mode: 'image' },
        },
      ],
      edges: [
        {
          id: 'prompt-to-generate',
          source: 'prompt',
          sourceHandle: 'text',
          target: 'generate',
          targetHandle: 'prompt',
        },
      ],
      viewport: { x: -12, y: 8, zoom: 0.75 },
      tray: ['text'],
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/v1/boards/${id}`,
          headers: headers(),
          payload: { rev: 0, state },
        })
      ).statusCode,
    ).toBe(200);
    const exported = await app.inject({
      method: 'GET',
      url: `/v1/boards/${id}/export.json`,
      headers: headers(),
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const bundle = exported.json() as {
      manifest: { schemaVersion: number; title: string };
      document: Record<string, unknown>;
    };
    expect(bundle.manifest).toMatchObject({
      schemaVersion: 1,
      title: 'Раунд-трип',
      assetPolicy: 'references-only',
    });
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/boards/import',
      headers: headers(),
      payload: { export: bundle },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const importedId = (imported.json() as { id: string }).id;
    boardsToClean.push(importedId);
    const importedRead = await app.inject({
      method: 'GET',
      url: `/v1/boards/${importedId}`,
      headers: headers(),
    });
    expect(importedRead.statusCode, importedRead.body).toBe(200);
    expect(withoutRevision(importedRead.json().state)).toEqual(withoutRevision(bundle.document));

    const rapidSave = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      headers: headers(),
      payload: {
        rev: 1,
        state: {
          ...state,
          nodes: [
            ...state.nodes,
            { id: 'text-2', type: 'text', position: { x: 40, y: 40 }, data: { text: 'ещё' } },
          ],
        },
      },
    });
    expect(rapidSave.statusCode, rapidSave.body).toBe(200);
    const autosaves = await db
      .select({ id: boardSnapshots.id })
      .from(boardSnapshots)
      .where(eq(boardSnapshots.boardId, id));
    expect(autosaves).toHaveLength(1);

    const foreignAssetId = nid();
    await db.insert(galleryItems).values({
      id: foreignAssetId,
      userId: attacker,
      assetUrl: `https://foreign.seed.test/${foreignAssetId}.png`,
      kind: 'image',
    });
    const foreignImport = await app.inject({
      method: 'POST',
      url: '/v1/boards/import',
      headers: headers(),
      payload: {
        export: {
          manifest: {
            format: 'vertov-board',
            formatVersion: 1,
            schemaVersion: 1,
            title: 'Чужая ссылка',
            assetPolicy: 'references-only',
          },
          document: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'foreign-media',
                type: 'media',
                position: { x: 0, y: 0 },
                data: {
                  url: `https://foreign.seed.test/${foreignAssetId}.png`,
                  mediaKind: 'image',
                  assetId: foreignAssetId,
                },
              },
            ],
            edges: [],
            tray: [],
          },
        },
      },
    });
    expect(foreignImport.statusCode, foreignImport.body).toBe(201);
    const foreignImportBody = foreignImport.json() as { id: string; placeholders: number };
    boardsToClean.push(foreignImportBody.id);
    expect(foreignImportBody.placeholders).toBe(1);
    const foreignImportedRead = await app.inject({
      method: 'GET',
      url: `/v1/boards/${foreignImportBody.id}`,
      headers: headers(),
    });
    expect(foreignImportedRead.json().state.nodes[0].data).toEqual({
      url: '',
      mediaKind: 'image',
    });
    expect(
      await db
        .select()
        .from(assetReferences)
        .where(eq(assetReferences.galleryItemId, foreignAssetId)),
    ).toHaveLength(0);

    const future = await app.inject({
      method: 'POST',
      url: '/v1/boards/import',
      headers: headers(),
      payload: { manifest: { schemaVersion: 88 }, document: {} },
    });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({
      error: 'unsupported_schema_version',
      supportedSchemaVersions: [1],
    });

    const nearLimitImport = await app.inject({
      method: 'POST',
      url: '/v1/boards/import',
      headers: headers(),
      payload: {
        padding: 'x'.repeat(1_100_000),
        manifest: {
          format: 'vertov-board',
          formatVersion: 1,
          schemaVersion: 1,
          title: 'Большой конверт',
          assetPolicy: 'references-only',
        },
        document: { schemaVersion: 1, nodes: [], edges: [], tray: [] },
      },
    });
    expect(nearLimitImport.statusCode, nearLimitImport.body).toBe(201);
    boardsToClean.push((nearLimitImport.json() as { id: string }).id);

    for (let index = 0; index < 24; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/boards/${id}/snapshots`,
        headers: headers(),
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    const snapshots = await db
      .select({ id: boardSnapshots.id })
      .from(boardSnapshots)
      .where(eq(boardSnapshots.boardId, id));
    expect(snapshots.length).toBeLessThanOrEqual(20);
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/boards/${id}/snapshots`,
      headers: headers(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.length).toBeLessThanOrEqual(20);
    const snapshotId = listed.json().items[0]?.id as string;
    const restored = await app.inject({
      method: 'POST',
      url: `/v1/boards/${id}/snapshots/${snapshotId}/restore`,
      headers: headers(),
      payload: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ ok: true, rev: expect.any(Number) });
  });
});
