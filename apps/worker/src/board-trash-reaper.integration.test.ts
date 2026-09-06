import 'dotenv/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { assetReferences, boards, db, galleryItems, nid, pool, usersApp } from '@seed/db';
import { sweepExpiredBoardTrash } from './board-trash-reaper';

let userId: string;
const boardIds: string[] = [];
const assetIds: string[] = [];

beforeAll(async () => {
  userId = nid();
  await db.insert(usersApp).values({ id: userId, displayName: 'Board trash worker', locale: 'ru' });
});

afterEach(async () => {
  if (boardIds.length > 0) {
    await db.delete(boards).where(inArray(boards.id, boardIds));
    boardIds.length = 0;
  }
  if (assetIds.length > 0) {
    await db.delete(galleryItems).where(inArray(galleryItems.id, assetIds));
    assetIds.length = 0;
  }
});

afterAll(async () => {
  await db.delete(usersApp).where(eq(usersApp.id, userId));
  await pool.end();
});

describe('board Trash purge worker', () => {
  it('purges only expired boards, detaches asset refs, and clears old backups', async () => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    const expiredId = nid();
    const retainedId = nid();
    const liveId = nid();
    boardIds.push(expiredId, retainedId, liveId);
    await db.insert(boards).values([
      {
        id: expiredId,
        userId,
        title: 'Истёк',
        state: {},
        trashedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000 - 1),
      },
      {
        id: retainedId,
        userId,
        title: 'Ещё хранится',
        state: {},
        trashedAt: new Date(now.getTime() - 1),
        stateBackup: { old: true },
        stateBackupAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1_000),
      },
      { id: liveId, userId, title: 'Живой', state: {} },
    ]);
    const assetId = nid();
    assetIds.push(assetId);
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.local/${assetId}.png`,
      kind: 'image',
    });
    await db.insert(assetReferences).values({
      id: nid(),
      galleryItemId: assetId,
      userId,
      refType: 'board_node',
      refId: `${expiredId}:node`,
    });

    expect(await sweepExpiredBoardTrash(now)).toEqual({ purged: 1, backupsCleared: 1 });
    expect(await sweepExpiredBoardTrash(now)).toEqual({ purged: 0, backupsCleared: 0 });
    expect(await db.select().from(boards).where(eq(boards.id, expiredId))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(boards)
        .where(and(eq(boards.userId, userId), inArray(boards.id, [retainedId, liveId]))),
    ).toHaveLength(2);
    const [retained] = await db
      .select({ stateBackup: boards.stateBackup, stateBackupAt: boards.stateBackupAt })
      .from(boards)
      .where(eq(boards.id, retainedId));
    expect(retained).toEqual({ stateBackup: null, stateBackupAt: null });
    expect(
      await db.select().from(assetReferences).where(eq(assetReferences.galleryItemId, assetId)),
    ).toHaveLength(0);
  });
});
