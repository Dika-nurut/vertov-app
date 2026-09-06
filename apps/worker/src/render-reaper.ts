import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db, studioRenders } from '@seed/db';
import { publishJobEvent } from './events';
import { reaperReapedTotal } from './metrics';

/**
 * The Studio analogue of {@link startReaper} (reconciled with backlog B-0). A
 * studio render can strand the user on a spinner forever in two ways: it flips
 * to `running` but never finishes (worker crash, hung ffmpeg, network split),
 * or it sits in `queued` and is never picked up (worker not consuming). This
 * sweeper flips both — running rows past the running timeout and queued rows
 * past the queued timeout — to `failed` so the client's status poll surfaces a
 * clear terminal state. Renders are NOT credit-reserved, so unlike the
 * generation reaper there is nothing to refund.
 *
 * Same shape as the generation reaper: Redis leader election per tick (one
 * sweeper across N workers) plus atomic `UPDATE … RETURNING`s so a reap can
 * never race the live render runner — it only claims rows still `queued` and
 * only completes rows still `running` (studio-render.ts conditional updates).
 */
const DEFAULT_INTERVAL_MS = 60_000;
// Renders run several sequential ffmpeg passes (each capped at 10m); allow
// generous headroom over a realistic worst case before declaring a render hung.
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
// A render that sits in `queued` this long never started — the worker isn't
// consuming the queue (worker down). Left alone the client polls forever, so
// reap it too. Renders aren't credit-reserved, so there's nothing to refund.
const DEFAULT_QUEUED_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LEADER_KEY = 'seed:render-reaper:leader';

export interface RenderReaperOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  timeoutMs?: number;
  queuedTimeoutMs?: number;
  /** Override the Redis leader key — used by tests to avoid contention. */
  leaderKey?: string;
}

export interface RenderReaperHandle {
  stop(): void;
  tick(): Promise<number>;
}

/**
 * The pure sweep: flip every `running` render older than `timeoutMs` to
 * `failed` in one atomic `UPDATE … RETURNING` (so a reap can never race the
 * live render runner — only rows still `running` at this instant move), and
 * publish a terminal event per reaped render. No leader election, no loop —
 * that wrapping lives in {@link startRenderReaper}; this is the unit a test can
 * call deterministically.
 */
export async function sweepStaleRenders(
  log: Logger,
  timeoutMs: number,
  queuedTimeoutMs: number,
): Promise<number> {
  const now = Date.now();
  const runningCutoff = new Date(now - timeoutMs);
  const queuedCutoff = new Date(now - queuedTimeoutMs);
  const flip = (where: ReturnType<typeof and>, message: string) =>
    db
      .update(studioRenders)
      .set({ status: 'failed', errorMessage: message, finishedAt: sql`now()` })
      .where(where)
      .returning({ id: studioRenders.id, userId: studioRenders.userId });

  // Marooned-in-running (worker crashed mid-render) + never-started-in-queue
  // (worker not consuming). Both atomic UPDATEs race-safely with the live render
  // runner — it only claims rows still `status='queued'` and only completes rows
  // still `status='running'` (studio-render.ts conditional updates).
  const reaped = [
    ...(await flip(
      and(eq(studioRenders.status, 'running'), lt(studioRenders.startedAt, runningCutoff)),
      `Render exceeded running timeout (${timeoutMs}ms).`,
    )),
    ...(await flip(
      and(eq(studioRenders.status, 'queued'), lt(studioRenders.createdAt, queuedCutoff)),
      `Render never started: queue not consumed within ${queuedTimeoutMs}ms.`,
    )),
  ];

  for (const row of reaped) {
    publishJobEvent({ userId: row.userId, jobId: row.id, status: 'failed', source: 'studio' });
  }
  if (reaped.length > 0) {
    log.warn(
      { count: reaped.length, timeoutMs, queuedTimeoutMs },
      'render-reaper: timed out stuck renders',
    );
  }
  return reaped.length;
}

export function startRenderReaper(opts: RenderReaperOptions): RenderReaperHandle {
  const intervalMs =
    opts.intervalMs ?? Number(process.env.RENDER_REAPER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.RENDER_RUNNING_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const queuedTimeoutMs =
    opts.queuedTimeoutMs ??
    Number(process.env.RENDER_QUEUED_TIMEOUT_MS ?? DEFAULT_QUEUED_TIMEOUT_MS);
  const leaderKey = opts.leaderKey ?? DEFAULT_LEADER_KEY;
  const instanceId = randomUUID();

  let stopped = false;

  async function tick(): Promise<number> {
    // TTL shorter than intervalMs so the leader's lock expires before the next
    // tick fires (otherwise the reaper effectively runs at half rate).
    const lockTtl = Math.max(500, Math.floor(intervalMs * 0.8));
    const acquired = await opts.redis.set(leaderKey, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') {
      opts.log.debug({ instanceId }, 'render-reaper: skipping tick (not leader)');
      return 0;
    }
    const reaped = await sweepStaleRenders(opts.log, timeoutMs, queuedTimeoutMs);
    if (reaped > 0) reaperReapedTotal.labels('render').inc(reaped);
    return reaped;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        opts.log.error({ err }, 'render-reaper tick failed');
      }
      if (stopped) break;
      // unref so a pending sleep never keeps a process alive on its own (the
      // real worker stays up via its BullMQ workers; tests exit cleanly).
      await new Promise((r) => {
        const t = setTimeout(r, intervalMs);
        if (typeof t.unref === 'function') t.unref();
      });
    }
  }

  void loop();

  opts.log.info({ intervalMs, timeoutMs, queuedTimeoutMs, instanceId }, 'render-reaper started');

  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
