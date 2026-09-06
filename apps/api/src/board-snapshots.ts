import { and, desc, eq, notInArray } from 'drizzle-orm';
import { boardSnapshots, db, nid } from '@seed/db';
import type { BoardDocument } from '@seed/shared/board-contract';

type BoardTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const BOARD_TRASH_RETENTION_DAYS = 30;
export const BOARD_TRASH_RETENTION_MS = BOARD_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const BOARD_SNAPSHOT_RETENTION = 20;
export const BOARD_AUTOSAVE_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1_000;

export type BoardSnapshotReason = 'autosave' | 'manual' | 'pre-destructive';

export interface BoardSnapshotWrite {
  boardId: string;
  rev: number;
  state: BoardDocument;
  reason: BoardSnapshotReason;
  now?: Date;
  /** Autosave snapshots are skipped when the previous autosave is recent. */
  respectAutosaveCadence?: boolean;
}

/**
 * Append one validated state to the board history and prune in the same
 * transaction. The caller owns the transaction so a pre-destructive snapshot
 * can never commit without the destructive action that follows it.
 */
export async function writeBoardSnapshot(
  tx: BoardTransaction,
  input: BoardSnapshotWrite,
): Promise<boolean> {
  const now = input.now ?? new Date();
  if (input.reason === 'autosave' && input.respectAutosaveCadence !== false) {
    const latest = await tx
      .select({ createdAt: boardSnapshots.createdAt })
      .from(boardSnapshots)
      .where(and(eq(boardSnapshots.boardId, input.boardId), eq(boardSnapshots.reason, 'autosave')))
      .orderBy(desc(boardSnapshots.createdAt), desc(boardSnapshots.id))
      .limit(1);
    if (
      latest[0]?.createdAt &&
      now.getTime() - latest[0].createdAt.getTime() < BOARD_AUTOSAVE_SNAPSHOT_INTERVAL_MS
    ) {
      return false;
    }
  }

  await tx.insert(boardSnapshots).values({
    id: nid(),
    boardId: input.boardId,
    rev: input.rev,
    state: input.state as unknown as Record<string, unknown>,
    reason: input.reason,
    createdAt: now,
  });

  const all = await tx
    .select({ id: boardSnapshots.id })
    .from(boardSnapshots)
    .where(eq(boardSnapshots.boardId, input.boardId))
    .orderBy(desc(boardSnapshots.createdAt), desc(boardSnapshots.id));
  const keep = all.slice(0, BOARD_SNAPSHOT_RETENTION).map((row) => row.id);
  const stale = all.slice(BOARD_SNAPSHOT_RETENTION).map((row) => row.id);
  if (stale.length > 0 && keep.length > 0) {
    await tx
      .delete(boardSnapshots)
      .where(and(eq(boardSnapshots.boardId, input.boardId), notInArray(boardSnapshots.id, keep)));
  }
  return true;
}

export async function forceBoardSnapshot(
  tx: BoardTransaction,
  boardId: string,
  rev: number,
  state: BoardDocument,
  now = new Date(),
): Promise<void> {
  await writeBoardSnapshot(tx, {
    boardId,
    rev,
    state,
    reason: 'pre-destructive',
    now,
    respectAutosaveCadence: false,
  });
}
