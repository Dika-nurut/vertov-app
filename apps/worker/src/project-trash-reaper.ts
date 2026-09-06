import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { db, projects } from '@seed/db';
import { reaperReapedTotal } from './metrics';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const LEADER_KEY = 'seed:project-trash-reaper:leader';

export interface ProjectTrashReaperOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  firstTickDelayMs?: number;
  batchSize?: number;
}

export interface ProjectTrashReaperHandle {
  stop(): void;
  tick(): Promise<{ purged: number }>;
}

/**
 * Permanently removes one bounded batch whose explicit 30-day retention
 * deadline has elapsed.
 *
 * Each candidate is locked, and the final DELETE repeats id + owner + trash
 * state + deadline predicates. A concurrent restore therefore wins cleanly or
 * observes the completed purge; a retry sees no row and is an idempotent no-op.
 * Carrying user_id from selection into every DELETE also makes ownership an
 * invariant of the automated purge path, rather than trusting project ids
 * alone.
 */
export async function sweepExpiredProjectTrash(
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<{ purged: number }> {
  const purged = await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: projects.id, userId: projects.userId })
      .from(projects)
      .where(and(isNotNull(projects.deletedAt), lte(projects.purgeAfter, now)))
      .orderBy(asc(projects.purgeAfter), asc(projects.id))
      .limit(Math.max(1, batchSize))
      .for('update', { skipLocked: true });

    const ids: string[] = [];
    for (const candidate of candidates) {
      const deleted = await tx
        .delete(projects)
        .where(
          and(
            eq(projects.id, candidate.id),
            eq(projects.userId, candidate.userId),
            isNotNull(projects.deletedAt),
            lte(projects.purgeAfter, now),
          ),
        )
        .returning({ id: projects.id });
      if (deleted.length === 1) ids.push(candidate.id);
    }
    return ids;
  });
  return { purged: purged.length };
}

export function startProjectTrashReaper(opts: ProjectTrashReaperOptions): ProjectTrashReaperHandle {
  const intervalMs =
    opts.intervalMs ?? Number(process.env.PROJECT_TRASH_REAPER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const firstDelay = opts.firstTickDelayMs ?? 60_000;
  const batchSize =
    opts.batchSize ?? Number(process.env.PROJECT_TRASH_REAPER_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  const instanceId = randomUUID();
  let stopped = false;

  async function tick(): Promise<{ purged: number }> {
    const lockTtl = Math.max(1_000, Math.floor(intervalMs * 0.8));
    const acquired = await opts.redis.set(LEADER_KEY, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') return { purged: 0 };
    const result = await sweepExpiredProjectTrash(new Date(), batchSize);
    if (result.purged > 0) {
      reaperReapedTotal.labels('project-trash').inc(result.purged);
      opts.log.info(result, 'project-trash-reaper: expired projects permanently deleted');
    }
    return result;
  }

  async function loop(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, firstDelay));
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        opts.log.error({ error }, 'project-trash-reaper: tick failed');
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, batchSize, instanceId }, 'project-trash-reaper started');
  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
