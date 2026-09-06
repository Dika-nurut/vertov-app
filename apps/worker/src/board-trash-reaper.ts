import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { and, asc, eq, isNotNull, lte, lt, sql } from 'drizzle-orm';
import { assetReferences, boards, db } from '@seed/db';
import { reaperReapedTotal } from './metrics';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 100;
const BOARD_TRASH_RETENTION_DAYS = 30;
const BOARD_TRASH_RETENTION_MS = BOARD_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const LEADER_KEY = 'seed:board-trash-reaper:leader';

export interface BoardTrashReaperOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  firstTickDelayMs?: number;
  batchSize?: number;
}

export interface BoardTrashReaperHandle {
  stop(): void;
  tick(): Promise<{ purged: number; backupsCleared: number }>;
}

export async function sweepExpiredBoardTrash(
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<{ purged: number; backupsCleared: number }> {
  const cutoff = new Date(now.getTime() - BOARD_TRASH_RETENTION_MS);
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: boards.id, userId: boards.userId })
      .from(boards)
      .where(and(isNotNull(boards.trashedAt), lte(boards.trashedAt, cutoff)))
      .orderBy(asc(boards.trashedAt), asc(boards.id))
      .limit(Math.max(1, batchSize))
      .for('update', { skipLocked: true });

    let purged = 0;
    for (const candidate of candidates) {
      await tx
        .delete(assetReferences)
        .where(
          and(
            eq(assetReferences.userId, candidate.userId),
            eq(assetReferences.refType, 'board_node'),
            sql`left(${assetReferences.refId}, length(${`${candidate.id}:`})) = ${`${candidate.id}:`}`,
          ),
        );
      const deleted = await tx
        .delete(boards)
        .where(
          and(
            eq(boards.id, candidate.id),
            eq(boards.userId, candidate.userId),
            isNotNull(boards.trashedAt),
            lte(boards.trashedAt, cutoff),
          ),
        )
        .returning({ id: boards.id });
      if (deleted.length > 0) purged += 1;
    }

    const backups = await tx
      .update(boards)
      .set({ stateBackup: null, stateBackupAt: null })
      .where(lt(boards.stateBackupAt, cutoff))
      .returning({ id: boards.id });
    return { purged, backupsCleared: backups.length };
  });
}

export function startBoardTrashReaper(opts: BoardTrashReaperOptions): BoardTrashReaperHandle {
  const intervalMs =
    opts.intervalMs ?? Number(process.env.BOARD_TRASH_REAPER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const firstDelay = opts.firstTickDelayMs ?? 60_000;
  const batchSize =
    opts.batchSize ?? Number(process.env.BOARD_TRASH_REAPER_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  const instanceId = randomUUID();
  let stopped = false;

  async function tick(): Promise<{ purged: number; backupsCleared: number }> {
    const lockTtl = Math.max(1_000, Math.floor(intervalMs * 0.8));
    const acquired = await opts.redis.set(LEADER_KEY, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') return { purged: 0, backupsCleared: 0 };
    const result = await sweepExpiredBoardTrash(new Date(), batchSize);
    if (result.purged > 0) {
      reaperReapedTotal.labels('board-trash').inc(result.purged);
      opts.log.info(
        { ...result, retentionDays: BOARD_TRASH_RETENTION_DAYS },
        'board-trash-reaper: expired boards permanently deleted',
      );
    }
    return result;
  }

  async function loop(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, firstDelay));
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        opts.log.error({ error }, 'board-trash-reaper: tick failed');
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, batchSize, instanceId }, 'board-trash-reaper started');
  return {
    stop: () => {
      stopped = true;
    },
    tick,
  };
}
