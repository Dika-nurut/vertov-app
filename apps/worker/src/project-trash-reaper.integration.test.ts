import 'dotenv/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { sweepExpiredProjectTrash } from './project-trash-reaper';

let userId: string;
const projectIds: string[] = [];

beforeAll(async () => {
  userId = nid();
  await db.insert(usersApp).values({ id: userId, displayName: 'Trash worker', locale: 'ru' });
  await db.insert(usersPii).values({
    id: userId,
    email: `project-trash-worker+${userId}@seed.local`,
  });
});

afterAll(async () => {
  await db.delete(usersPii).where(eq(usersPii.id, userId));
  await db.delete(usersApp).where(eq(usersApp.id, userId));
  await pool.end();
});

afterEach(async () => {
  if (projectIds.length > 0) {
    await db.delete(projects).where(inArray(projects.id, projectIds));
    projectIds.length = 0;
  }
});

async function trashedProject(title: string, purgeAfter: Date): Promise<string> {
  const id = nid();
  projectIds.push(id);
  const deletedAt = new Date(purgeAfter.getTime() - 30 * 24 * 60 * 60 * 1000);
  await db.insert(projects).values({
    id,
    userId,
    title,
    deletedAt,
    purgeAfter,
    trashManifest: { version: 1, scripts: [], boards: [], studio: [], assets: [] },
  });
  return id;
}

describe('project Trash purge worker', () => {
  it('purges only expired trashed projects and is an idempotent no-op on retry', async () => {
    const now = new Date('2026-07-24T12:00:00.000Z');
    const expiredId = await trashedProject('Истёк', new Date(now.getTime() - 1));
    const retainedId = await trashedProject(
      'Ещё хранится',
      new Date(now.getTime() + 24 * 60 * 60 * 1000),
    );
    const liveId = nid();
    projectIds.push(liveId);
    await db.insert(projects).values({ id: liveId, userId, title: 'Живой' });

    expect(await sweepExpiredProjectTrash(now)).toEqual({ purged: 1 });
    expect(await sweepExpiredProjectTrash(now)).toEqual({ purged: 0 });
    expect(await db.select().from(projects).where(eq(projects.id, expiredId))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projects)
        .where(and(eq(projects.userId, userId), inArray(projects.id, [retainedId, liveId]))),
    ).toHaveLength(2);
  });

  it('hard-delete detaches retained documents only after the retention deadline', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const projectId = await trashedProject('Структура', new Date(now.getTime() - 1));
    const scriptId = nid();
    const boardId = nid();
    const studioId = nid();
    await db.insert(scripts).values({ id: scriptId, userId, projectId, title: 'Сценарий' });
    await db.insert(boards).values({ id: boardId, userId, projectId, title: 'Доска', state: {} });
    await db
      .insert(studioProjects)
      .values({ id: studioId, userId, projectId, title: 'Монтаж', timeline: {} });

    expect(await sweepExpiredProjectTrash(now)).toEqual({ purged: 1 });
    const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId));
    const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
    const [studio] = await db.select().from(studioProjects).where(eq(studioProjects.id, studioId));
    expect(script?.projectId).toBeNull();
    expect(board?.projectId).toBeNull();
    expect(studio?.projectId).toBeNull();
  });
});
