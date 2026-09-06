import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  boards,
  db,
  nid,
  pool,
  projects,
  scripts,
  studioProjects,
  usersApp,
  usersPii,
} from '@seed/db';
import { setupBoardRoutes } from '../src/boards';
import { setupScriptRoutes } from '../src/scripts';
import { setupStudioRoutes } from '../src/studio';

const ownerId = nid();
const foreignUserId = nid();
const projectId = nid();
const emptyProjectId = nid();
const limitProjectId = nid();
const reopenProjectId = nid();
const deletedProjectId = nid();
const foreignProjectId = nid();
let app: ReturnType<typeof Fastify>;

async function insertUser(id: string, label: string) {
  await db.insert(usersApp).values({ id, displayName: label, locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `resolver-${id}@seed.local` });
}

async function resolve(path: 'scenario' | 'boards' | 'studio', id = projectId) {
  return app.inject({ method: 'POST', url: `/v1/projects/${id}/resolve/${path}` });
}

beforeAll(async () => {
  await insertUser(ownerId, 'Resolver owner');
  await insertUser(foreignUserId, 'Resolver foreign');
  await db.insert(projects).values([
    { id: projectId, userId: ownerId, title: 'Resolver project' },
    { id: emptyProjectId, userId: ownerId, title: 'Empty resolver project' },
    { id: limitProjectId, userId: ownerId, title: 'Limited resolver project' },
    { id: reopenProjectId, userId: ownerId, title: 'Reopened resolver project' },
    {
      id: deletedProjectId,
      userId: ownerId,
      title: 'Deleted resolver project',
      deletedAt: new Date(),
    },
    { id: foreignProjectId, userId: foreignUserId, title: 'Foreign resolver project' },
  ]);
  app = Fastify({ logger: false });
  const requireSession = async () => ({ user: { id: ownerId } });
  setupScriptRoutes(app, requireSession);
  setupBoardRoutes(app, requireSession);
  setupStudioRoutes(app, requireSession);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.delete(studioProjects).where(inArray(studioProjects.userId, [ownerId, foreignUserId]));
  await db.delete(boards).where(inArray(boards.userId, [ownerId, foreignUserId]));
  await db.delete(scripts).where(inArray(scripts.userId, [ownerId, foreignUserId]));
  await db.delete(projects).where(inArray(projects.userId, [ownerId, foreignUserId]));
  await db.delete(usersPii).where(inArray(usersPii.id, [ownerId, foreignUserId]));
  await db.delete(usersApp).where(inArray(usersApp.id, [ownerId, foreignUserId]));
  await pool.end();
});

describe('project document resolvers', () => {
  it('opens the project document with the greatest updatedAt, then id', async () => {
    const earlier = new Date('2026-01-01T00:00:00.000Z');
    const later = new Date('2026-01-02T00:00:00.000Z');
    const scriptId = nid();
    const boardId = nid();
    const studioId = nid();
    const newestScriptId = nid();
    const newestBoardId = nid();
    const newestStudioId = nid();
    await db.insert(scripts).values([
      { id: scriptId, userId: ownerId, projectId, updatedAt: earlier },
      { id: newestScriptId, userId: ownerId, projectId, updatedAt: later },
    ]);
    await db.insert(boards).values([
      { id: boardId, userId: ownerId, projectId, state: {}, updatedAt: earlier },
      { id: newestBoardId, userId: ownerId, projectId, state: {}, updatedAt: later },
    ]);
    await db.insert(studioProjects).values([
      { id: studioId, userId: ownerId, projectId, timeline: {}, updatedAt: earlier },
      { id: newestStudioId, userId: ownerId, projectId, timeline: {}, updatedAt: later },
    ]);

    for (const [kind, expectedId] of [
      ['scenario', newestScriptId],
      ['boards', newestBoardId],
      ['studio', newestStudioId],
    ] as const) {
      const response = await resolve(kind);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ destination: 'document', id: expectedId });
    }
  });

  it('serializes rapid duplicate resolution so every empty project gets one document per kind', async () => {
    for (const kind of ['scenario', 'boards', 'studio'] as const) {
      const responses = await Promise.all([
        resolve(kind, emptyProjectId),
        resolve(kind, emptyProjectId),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      const ids = responses.map((response) => (response.json() as { id: string }).id);
      expect(new Set(ids).size).toBe(1);
    }

    expect(
      await db
        .select({ id: scripts.id })
        .from(scripts)
        .where(and(eq(scripts.userId, ownerId), eq(scripts.projectId, emptyProjectId))),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: boards.id })
        .from(boards)
        .where(and(eq(boards.userId, ownerId), eq(boards.projectId, emptyProjectId))),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: studioProjects.id })
        .from(studioProjects)
        .where(
          and(eq(studioProjects.userId, ownerId), eq(studioProjects.projectId, emptyProjectId)),
        ),
    ).toHaveLength(1);
  });

  // A tile must stay clickable for the whole life of a project, however its
  // documents come and go. Two ways a project empties out again:
  //   deleted  — the user threw the draft away (documents are hard-deleted);
  //   moved    — the document left for another project. Nothing does that today,
  //              but R10 (adopt-by-drag) is specified to, by writing projectId.
  // The second case is why the resolver must not stamp a stable createKey on the
  // script it creates: scripts carries a unique (user_id, create_key) index, and
  // a per-project constant key collides with its own earlier row the moment that
  // row still exists but has left the project — 500, and the tile is dead for
  // good. Red on a `createKey: intent` resolver, green without one.
  it('stays resolvable after its document is deleted, and after one moves away', async () => {
    for (const kind of ['scenario', 'boards', 'studio'] as const) {
      const first = await resolve(kind, reopenProjectId);
      expect(first.statusCode, first.body).toBe(200);
      const firstId = (first.json() as { id: string }).id;

      if (kind === 'scenario') await db.delete(scripts).where(eq(scripts.id, firstId));
      if (kind === 'boards') await db.delete(boards).where(eq(boards.id, firstId));
      if (kind === 'studio') await db.delete(studioProjects).where(eq(studioProjects.id, firstId));

      const second = await resolve(kind, reopenProjectId);
      expect(second.statusCode, `${kind} after delete: ${second.body}`).toBe(200);
      const secondId = (second.json() as { id: string }).id;
      expect(secondId).not.toBe(firstId);

      // Now move it out instead of deleting it — the R10 shape.
      if (kind === 'scenario') {
        await db.update(scripts).set({ projectId: null }).where(eq(scripts.id, secondId));
      }
      if (kind === 'boards') {
        await db.update(boards).set({ projectId: null }).where(eq(boards.id, secondId));
      }
      if (kind === 'studio') {
        await db
          .update(studioProjects)
          .set({ projectId: null })
          .where(eq(studioProjects.id, secondId));
      }

      const third = await resolve(kind, reopenProjectId);
      expect(third.statusCode, `${kind} after move-out: ${third.body}`).toBe(200);
      expect((third.json() as { id: string }).id).not.toBe(secondId);
    }
  });

  it('returns 404 without creating for foreign and soft-deleted projects', async () => {
    for (const kind of ['scenario', 'boards', 'studio'] as const) {
      for (const unavailableProjectId of [foreignProjectId, deletedProjectId]) {
        const response = await resolve(kind, unavailableProjectId);
        expect(response.statusCode, `${kind} ${unavailableProjectId}`).toBe(404);
      }
    }
    expect(
      await db
        .select({ id: scripts.id })
        .from(scripts)
        .where(inArray(scripts.projectId, [foreignProjectId, deletedProjectId])),
    ).toEqual([]);
    expect(
      await db
        .select({ id: boards.id })
        .from(boards)
        .where(inArray(boards.projectId, [foreignProjectId, deletedProjectId])),
    ).toEqual([]);
    expect(
      await db
        .select({ id: studioProjects.id })
        .from(studioProjects)
        .where(inArray(studioProjects.projectId, [foreignProjectId, deletedProjectId])),
    ).toEqual([]);
  });

  it('degrades to the list at each per-user creation limit without creating', async () => {
    await db
      .insert(scripts)
      .values(Array.from({ length: 100 }, () => ({ id: nid(), userId: ownerId })));
    await db
      .insert(boards)
      .values(Array.from({ length: 50 }, () => ({ id: nid(), userId: ownerId, state: {} })));
    await db
      .insert(studioProjects)
      .values(Array.from({ length: 50 }, () => ({ id: nid(), userId: ownerId, timeline: {} })));

    for (const kind of ['scenario', 'boards', 'studio'] as const) {
      const response = await resolve(kind, limitProjectId);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ destination: 'list' });
    }
    expect(
      await db
        .select({ id: scripts.id })
        .from(scripts)
        .where(eq(scripts.projectId, limitProjectId)),
    ).toEqual([]);
    expect(
      await db.select({ id: boards.id }).from(boards).where(eq(boards.projectId, limitProjectId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: studioProjects.id })
        .from(studioProjects)
        .where(eq(studioProjects.projectId, limitProjectId)),
    ).toEqual([]);
  });

  it('returns unauthenticated before it can resolve or create', async () => {
    const anonymous = Fastify({ logger: false });
    const requireSession = async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.status(401).send({ error: 'unauthenticated' });
      return null;
    };
    setupScriptRoutes(anonymous, requireSession);
    setupBoardRoutes(anonymous, requireSession);
    setupStudioRoutes(anonymous, requireSession);
    await anonymous.ready();
    try {
      for (const kind of ['scenario', 'boards', 'studio'] as const) {
        const response = await anonymous.inject({
          method: 'POST',
          url: `/v1/projects/${limitProjectId}/resolve/${kind}`,
        });
        expect(response.statusCode).toBe(401);
      }
    } finally {
      await anonymous.close();
    }
  });
});
