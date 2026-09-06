import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Queue } from 'bullmq';
import { eq, like } from 'drizzle-orm';
import { db, outboxJobs, pool } from '@seed/db';
import { CREDIT_COMMIT_QUEUE, JOB_RUN_QUEUE } from '../src/queues';
import { enqueueViaOutbox, startOutboxDrainer } from '../src/outbox';

/**
 * The outbox is the ONLY thing standing between a scheduled settlement and a
 * customer's stranded credits: by the time a commit/refund is queued, the claim
 * that owed it is already terminal and the reaper — which only inspects
 * `in_progress` claims — will never look at it again. "Durably queued" therefore
 * has to mean "eventually executed", which a dead-letter counter cannot promise.
 *
 * So: settlement rows are exempt from the attempt ceiling and pace themselves
 * with a backoff instead. Ordinary queues keep the ceiling unchanged.
 */

const log = pino({ level: 'silent' });
const MAX_ATTEMPTS = 3;
const TAG = `outbox-settlement-${Date.now()}`;

/**
 * A queue whose `add` fails `failures` times for OUR row before it starts
 * working. Rows belonging to any other test are refused untouched: the outbox
 * table is shared, and this drainer must neither settle nor count a row it does
 * not own (refusing leaves them exactly as they were — still unprocessed).
 */
function flakyQueue(failures: number, ownJobId: string) {
  const calls: Array<{ name: string; opts: Record<string, unknown> }> = [];
  let seen = 0;
  const queue = {
    add: async (name: string, _payload: unknown, opts: Record<string, unknown>) => {
      if (opts.jobId !== ownJobId) throw new Error('not this test`s row');
      seen += 1;
      if (seen <= failures) throw new Error(`redis unreachable (call ${seen})`);
      calls.push({ name, opts });
      return { id: 'x' };
    },
  } as unknown as Queue;
  return { queue, calls, attempted: () => seen };
}

const rowFor = async (id: string) =>
  (await db.select().from(outboxJobs).where(eq(outboxJobs.id, id)))[0];

async function enqueue(queueName: string, jobId: string): Promise<string> {
  return db.transaction((tx) => enqueueViaOutbox({ tx, queueName, jobId, payload: { tag: TAG } }));
}

/**
 * Drain until `done()`, giving the row's backoff real (millisecond) time to
 * elapse between passes. Nothing here touches the database directly — the point
 * is that recovery needs no manual intervention.
 */
async function drainUntil(
  drainer: { drain: () => Promise<number> },
  done: () => Promise<boolean>,
  passes = 40,
): Promise<number> {
  for (let pass = 1; pass <= passes; pass++) {
    await drainer.drain();
    if (await done()) return pass;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return -1;
}

afterAll(async () => {
  await db.delete(outboxJobs).where(like(outboxJobs.jobId, `${TAG}%`));
  await pool.end();
});

describe('outbox drainer — settlement rows are never abandoned', () => {
  it('a commit row keeps retrying past MAX_OUTBOX_ATTEMPTS and settles itself once the queue recovers', async () => {
    // Fails well past the dead-letter ceiling, then recovers — the shape of a
    // Redis outage that outlives a few retries.
    const failing = flakyQueue(MAX_ATTEMPTS + 2, `${TAG}-commit`);
    const drainer = startOutboxDrainer({
      log,
      queues: { [CREDIT_COMMIT_QUEUE]: failing.queue },
      intervalMs: 3_600_000,
      maxAttempts: MAX_ATTEMPTS,
      settlementRetryBaseMs: 1,
    });
    drainer.stop();

    const rowId = await enqueue(CREDIT_COMMIT_QUEUE, `${TAG}-commit`);
    const passes = await drainUntil(
      drainer,
      async () => (await rowFor(rowId))?.processedAt != null,
    );

    expect(passes).toBeGreaterThan(0);
    const row = await rowFor(rowId);
    // It settled only AFTER exceeding the ceiling that would have dropped it.
    expect(row!.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
    expect(row!.processedAt).not.toBeNull();
    expect(failing.calls).toHaveLength(1);

    // And the job it finally enqueued carries the settlement retry policy —
    // BullMQ's default of a single attempt would re-open the same hole one
    // layer down, where the outbox row is already marked processed.
    const opts = failing.calls[0]!.opts;
    expect(opts.jobId).toBe(`${TAG}-commit`);
    expect(opts.attempts as number).toBeGreaterThan(1000);
    expect(opts.removeOnFail).toBe(false);
  });

  it('an ordinary queue still dead-letters at the ceiling (unchanged semantics)', async () => {
    const failing = flakyQueue(MAX_ATTEMPTS + 2, `${TAG}-run`);
    const drainer = startOutboxDrainer({
      log,
      queues: { [JOB_RUN_QUEUE]: failing.queue },
      intervalMs: 3_600_000,
      maxAttempts: MAX_ATTEMPTS,
      settlementRetryBaseMs: 1,
    });
    drainer.stop();

    const rowId = await enqueue(JOB_RUN_QUEUE, `${TAG}-run`);
    for (let pass = 0; pass < 8; pass++) await drainer.drain();

    const row = await rowFor(rowId);
    // Stopped being retried at the ceiling, exactly as before.
    expect(row!.attempts).toBe(MAX_ATTEMPTS);
    expect(row!.processedAt).toBeNull();
    expect(failing.attempted()).toBe(MAX_ATTEMPTS);
    // No backoff was written for a non-money row — its pacing is untouched.
    expect(row!.nextAttemptAt).toBeNull();
  });
});
