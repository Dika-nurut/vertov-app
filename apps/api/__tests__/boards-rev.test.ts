import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { assetReferences, boards, db, galleryItems, nid, pool, usersApp, usersPii } from '@seed/db';
import { setupBoardRoutes } from '../src/boards';

const createdUsers: string[] = [];
const createdBoards: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'BoardRev', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `board-rev+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

let userId: string;
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  userId = await makeUser();
  app = Fastify({ logger: false });
  setupBoardRoutes(app, async () => ({ user: { id: userId } }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (createdBoards.length) await db.delete(boards).where(inArray(boards.id, createdBoards));
  for (const id of createdUsers) {
    await db.delete(boards).where(eq(boards.userId, id));
    await db.delete(usersPii).where(eq(usersPii.id, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  await pool.end();
});

async function createBoard(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/boards',
    payload: { title: 'Rev contract' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { id: string; state: Record<string, unknown> };
  expect(body.state).toEqual({ schemaVersion: 1, nodes: [], edges: [], tray: [], __rev: 0 });
  const id = body.id;
  createdBoards.push(id);
  return id;
}

async function stateOf(id: string): Promise<Record<string, unknown>> {
  const row = (await db.select().from(boards).where(eq(boards.id, id)).limit(1))[0]!;
  return row.state as Record<string, unknown>;
}

function noteState(id: string) {
  return {
    nodes: [
      {
        id,
        type: 'note',
        position: { x: 0, y: 0 },
        data: { text: id },
      },
    ],
    edges: [],
  };
}

describe('board autosave revision guard', () => {
  it('persists gallery identity, syncs shared usage, and leaves retention unchanged', async () => {
    const id = await createBoard();
    const assetId = nid();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.local/${assetId}.png`,
      kind: 'image',
      expiresAt,
    });
    const identifiedState = {
      nodes: [
        {
          id: 'media-1',
          type: 'media',
          position: { x: 0, y: 0 },
          data: {
            url: `https://assets.seed.local/snapshot-${assetId}.png`,
            mediaKind: 'image',
            assetId,
          },
        },
      ],
      edges: [],
    };
    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { state: identifiedState, rev: 0 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await stateOf(id)).toMatchObject({
      nodes: [{ id: 'media-1', data: { assetId } }],
    });
    expect(
      await db
        .select({ assetId: assetReferences.galleryItemId, refId: assetReferences.refId })
        .from(assetReferences)
        .where(eq(assetReferences.galleryItemId, assetId)),
    ).toEqual([{ assetId, refId: `${id}:media-1` }]);
    expect(
      (
        await db
          .select({ expiresAt: galleryItems.expiresAt })
          .from(galleryItems)
          .where(eq(galleryItems.id, assetId))
      )[0]?.expiresAt,
    ).toEqual(expiresAt);

    const legacy = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: {
        state: {
          nodes: [
            {
              id: 'legacy',
              type: 'media',
              position: { x: 0, y: 0 },
              data: { url: 'https://external.example/legacy.png', mediaKind: 'image' },
            },
          ],
          edges: [],
        },
        rev: 1,
      },
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(
      await db
        .select({ id: assetReferences.id })
        .from(assetReferences)
        .where(eq(assetReferences.galleryItemId, assetId)),
    ).toEqual([]);
  });

  it('treats rev as the expected base, increments on the server, and rejects stale saves', async () => {
    const id = await createBoard();

    const first = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { state: noteState('first'), rev: 0 },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ ok: true, rev: 1 });

    const stale = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { state: noteState('stale'), rev: 0 },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toEqual({ error: 'rev_conflict', rev: 1 });
    expect(await stateOf(id)).toMatchObject({
      __rev: 1,
      schemaVersion: 1,
      nodes: [{ id: 'first', version: 1 }],
    });

    const second = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { state: noteState('second'), rev: 1 },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual({ ok: true, rev: 2 });
    expect(await stateOf(id)).toMatchObject({
      __rev: 2,
      schemaVersion: 1,
      nodes: [{ id: 'second', version: 1 }],
    });
  });

  it('allows exactly one of two concurrent writers with the same expected base', async () => {
    const id = await createBoard();

    const [left, right] = await Promise.all(
      ['left', 'right'].map((candidate) =>
        app.inject({
          method: 'PUT',
          url: `/v1/boards/${id}`,
          payload: { state: noteState(candidate), rev: 0 },
        }),
      ),
    );
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    const accepted = [left, right].find((response) => response.statusCode === 200)!;
    const rejected = [left, right].find((response) => response.statusCode === 409)!;
    expect(accepted.json()).toEqual({ ok: true, rev: 1 });
    expect(rejected.json()).toEqual({ error: 'rev_conflict', rev: 1 });
    expect(await stateOf(id)).toMatchObject({
      __rev: 1,
      nodes: [{ id: expect.stringMatching(/^(left|right)$/), version: 1 }],
    });
  });

  it('requires a revision for document writes but keeps title-only updates compatible', async () => {
    const id = await createBoard();

    const raw = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { state: noteState('raw') },
    });
    expect(raw.statusCode, raw.body).toBe(400);
    expect(raw.json()).toEqual({ error: 'rev_required' });
    expect(await stateOf(id)).toEqual({
      schemaVersion: 1,
      nodes: [],
      edges: [],
      tray: [],
      __rev: 0,
    });

    const title = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { title: 'Renamed safely' },
    });
    expect(title.statusCode, title.body).toBe(200);
    expect(title.json()).toEqual({ ok: true });
    expect(await stateOf(id)).toMatchObject({
      __rev: 0,
      schemaVersion: 1,
      nodes: [],
    });
  });

  it('rejects invalid expected revisions before touching the document', async () => {
    const id = await createBoard();
    for (const rev of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
      const response = await app.inject({
        method: 'PUT',
        url: `/v1/boards/${id}`,
        payload: { state: noteState('invalid-rev'), rev },
      });
      expect(response.statusCode, `${rev}: ${response.body}`).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_body' });
    }
    expect(await stateOf(id)).toMatchObject({ __rev: 0, nodes: [] });
  });

  it('rejects malformed/future documents without overwriting the last valid state', async () => {
    const id = await createBoard();
    const valid = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { state: noteState('valid'), rev: 0 },
    });
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json()).toEqual({ ok: true, rev: 1 });

    const malformed = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: {
        state: {
          schemaVersion: 1,
          nodes: [],
          edges: [{ id: 'e1', source: 'missing', target: 'missing' }],
        },
        rev: 1,
      },
    });
    expect(malformed.statusCode, malformed.body).toBe(400);
    expect(malformed.json()).toMatchObject({ error: 'invalid_state' });

    const future = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { state: { schemaVersion: 2, nodes: [], edges: [] }, rev: 1 },
    });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json()).toMatchObject({ error: 'invalid_state' });
    expect(await stateOf(id)).toMatchObject({
      __rev: 1,
      nodes: [{ id: 'valid' }],
    });
  });

  it('rejects documents above 1 MiB at the HTTP boundary without changing stored state', async () => {
    const id = await createBoard();
    const valid = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: { state: noteState('before-oversized-write'), rev: 0 },
    });
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json()).toEqual({ ok: true, rev: 1 });

    const oversized = await app.inject({
      method: 'PUT',
      url: `/v1/boards/${id}`,
      payload: {
        state: {
          nodes: [
            {
              id: 'oversized',
              type: 'note',
              position: { x: 0, y: 0 },
              data: { text: 'x'.repeat(1_048_576) },
            },
          ],
          edges: [],
        },
        rev: 1,
      },
    });
    expect(oversized.statusCode, oversized.body).toBe(400);
    expect(oversized.json()).toEqual({ error: 'state_too_large' });
    expect(await stateOf(id)).toMatchObject({
      __rev: 1,
      nodes: [{ id: 'before-oversized-write' }],
    });
  });

  it('migrates legacy state on read and fails closed on corrupt stored state', async () => {
    const id = await createBoard();
    await db
      .update(boards)
      .set({ state: noteState('legacy') })
      .where(eq(boards.id, id));

    const legacy = await app.inject({ method: 'GET', url: `/v1/boards/${id}` });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.json()).toMatchObject({
      state: {
        schemaVersion: 1,
        nodes: [{ id: 'legacy', version: 1 }],
        edges: [],
        tray: [],
      },
    });

    await db
      .update(boards)
      .set({ state: { schemaVersion: 99, nodes: [], edges: [], tray: [] } })
      .where(eq(boards.id, id));
    const corrupt = await app.inject({ method: 'GET', url: `/v1/boards/${id}` });
    expect(corrupt.statusCode, corrupt.body).toBe(409);
    expect(corrupt.json()).toMatchObject({
      error: 'invalid_board_state',
      code: 'BOARD_STATE_INVALID',
      boardId: id,
      recoveryAvailable: false,
    });
  });
});
