import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { boards, db, nid, pool, usersApp, usersPii } from '@seed/db';
import { setupBoardRoutes } from '../src/boards';
import { setupStoryboardRoutes } from '../src/storyboard';

const userIds: string[] = [];
const boardIds: string[] = [];

async function createUser(label: string) {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: label, locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `boards-ownership+${id}@seed.local` });
  userIds.push(id);
  return id;
}

let ownerId: string;
let attackerId: string;
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  ownerId = await createUser('Board owner');
  attackerId = await createUser('Board attacker');
  app = Fastify({ logger: false });
  const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.headers['x-test-user'];
    if (typeof userId !== 'string') {
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return { user: { id: userId } };
  };
  setupBoardRoutes(app, requireSession);
  setupStoryboardRoutes(app, requireSession);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (boardIds.length) await db.delete(boards).where(inArray(boards.id, boardIds));
  if (userIds.length) {
    await db.delete(usersPii).where(inArray(usersPii.id, userIds));
    await db.delete(usersApp).where(inArray(usersApp.id, userIds));
  }
  await pool.end();
});

const headers = (userId: string) => ({ 'x-test-user': userId });

describe('Boards ownership boundary', () => {
  it('hides and preserves an owner Board across every attacker mutation/export route', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/boards',
      headers: headers(ownerId),
      payload: { title: 'Owner secret Board' },
    });
    expect(created.statusCode).toBe(201);
    const boardId = (created.json() as { id: string }).id;
    boardIds.push(boardId);

    const attackerList = await app.inject({
      method: 'GET',
      url: '/v1/boards',
      headers: headers(attackerId),
    });
    expect(attackerList.statusCode).toBe(200);
    expect(attackerList.json()).toEqual({ items: [], nextCursor: null });

    const attempts = [
      { method: 'GET', url: `/v1/boards/${boardId}` },
      {
        method: 'PUT',
        url: `/v1/boards/${boardId}`,
        payload: { title: 'stolen' },
      },
      {
        method: 'PUT',
        url: `/v1/boards/${boardId}`,
        payload: { rev: 0, state: { nodes: [], edges: [], tray: [] } },
      },
      { method: 'DELETE', url: `/v1/boards/${boardId}` },
      { method: 'GET', url: `/v1/boards/${boardId}/storyboard.pdf` },
      { method: 'POST', url: `/v1/boards/${boardId}/share` },
      { method: 'DELETE', url: `/v1/boards/${boardId}/share` },
    ] as const;
    for (const attempt of attempts) {
      const response = await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: headers(attackerId),
        ...('payload' in attempt ? { payload: attempt.payload } : {}),
      });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });
    }

    const ownerRead = await app.inject({
      method: 'GET',
      url: `/v1/boards/${boardId}`,
      headers: headers(ownerId),
    });
    expect(ownerRead.statusCode).toBe(200);
    expect(ownerRead.json()).toMatchObject({
      id: boardId,
      userId: ownerId,
      title: 'Owner secret Board',
      state: { __rev: 0, nodes: [], edges: [], tray: [] },
      shareToken: null,
    });
  });

  it('rejects unauthenticated list and direct-read requests', async () => {
    for (const url of ['/v1/boards', `/v1/boards/${boardIds[0]}`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('mints an idempotent public token, rejects malformed tokens, and revokes access', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/boards',
      headers: headers(ownerId),
      payload: { title: 'Share lifecycle Board' },
    });
    expect(created.statusCode).toBe(201);
    const boardId = (created.json() as { id: string }).id;
    boardIds.push(boardId);

    const mint = () =>
      app.inject({
        method: 'POST',
        url: `/v1/boards/${boardId}/share`,
        headers: headers(ownerId),
      });
    const firstMint = await mint();
    expect(firstMint.statusCode).toBe(200);
    const firstToken = (firstMint.json() as { token: string }).token;
    expect(firstToken).toMatch(/^sb-[\w-]{10,}$/);

    const repeatedMint = await mint();
    expect(repeatedMint.statusCode).toBe(200);
    expect(repeatedMint.json()).toEqual({ token: firstToken });

    const malformed = await app.inject({ method: 'GET', url: '/v1/storyboard/not-a-token' });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toEqual({ error: 'not_found' });

    const publicRead = await app.inject({
      method: 'GET',
      url: `/v1/storyboard/${firstToken}`,
    });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.headers['content-type']).toContain('application/pdf');
    expect(publicRead.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/boards/${boardId}/share`,
      headers: headers(ownerId),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ ok: true });

    const revokedRead = await app.inject({
      method: 'GET',
      url: `/v1/storyboard/${firstToken}`,
    });
    expect(revokedRead.statusCode).toBe(404);
    expect(revokedRead.json()).toEqual({ error: 'not_found' });

    const secondMint = await mint();
    expect(secondMint.statusCode).toBe(200);
    const secondToken = (secondMint.json() as { token: string }).token;
    expect(secondToken).not.toBe(firstToken);
    const remintedRead = await app.inject({
      method: 'GET',
      url: `/v1/storyboard/${secondToken}`,
    });
    expect(remintedRead.statusCode).toBe(200);
    expect(remintedRead.headers['content-type']).toContain('application/pdf');
  });
});
