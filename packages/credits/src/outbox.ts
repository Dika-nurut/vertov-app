import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db as defaultDb, nid, outboxJobs } from '@seed/db';
import {
  AUTH_EMAIL_QUEUE,
  isSettlementQueue,
  settlementBackoffMs,
  SETTLEMENT_JOB_OPTIONS,
  SETTLEMENT_QUEUES,
  SETTLEMENT_RETRY_BASE_MS,
} from './queues';

/**
 * Auth email rows contain single-use links/codes while they are waiting for
 * the worker. Once the row has been handed to BullMQ, keep the delivery
 * marker/attempt metadata but remove the secret from the durable outbox row.
 * This prevents processed rows and database backups from becoming a second
 * replay store for login credentials. The queue job already owns the payload
 * for the bounded delivery/retry window.
 */
export function scrubProcessedOutboxPayload(
  queueName: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return queueName === AUTH_EMAIL_QUEUE ? { _redacted: true } : payload;
}

/**
 * Outbox pattern (deferred W1.Fri review #7).
 *
 * Goal: when a service writes a row and then enqueues a BullMQ job, the
 * window between commit and `queue.add()` is a transient failure mode —
 * if Redis is unreachable in that window, the queue entry is lost and
 * the DB row dangles forever. Solution: write to an `outbox_jobs` table
 * INSIDE the same transaction as the business write. A separate worker
 * loop drains pending rows by enqueuing them, then sets
 * `processed_at`. Replay of the same outbox row is idempotent because
 * the actual BullMQ enqueue uses a deterministic `jobId`.
 */

type DbLike = typeof defaultDb;
type Tx = Parameters<Parameters<DbLike['transaction']>[0]>[0];

export interface EnqueueOutboxInput {
  tx: Tx;
  queueName: string;
  payload: Record<string, unknown>;
  /** Optional BullMQ jobId so retries dedupe on the queue side too. */
  jobId?: string;
}

export async function enqueueViaOutbox(input: EnqueueOutboxInput): Promise<string> {
  const id = nid();
  await input.tx.insert(outboxJobs).values({
    id,
    queueName: input.queueName,
    payload: input.payload,
    jobId: input.jobId ?? null,
  });
  return id;
}

export interface OutboxDrainerOptions {
  log: Logger;
  queues: Record<string, Queue>;
  intervalMs?: number;
  batchSize?: number;
  /**
   * Rows whose `attempts` reaches this value stop being retried. A
   * single `outbox.dead_letter` error log per row gives the future
   * alerting bus a stable key to fire on. Default 10; override with
   * MAX_OUTBOX_ATTEMPTS.
   *
   * Does NOT apply to the settlement queues (see `SETTLEMENT_QUEUES`):
   * abandoning a commit/refund strands a customer's credits with no
   * other mechanism to recover them, so those retry indefinitely with
   * a capped backoff instead.
   */
  maxAttempts?: number;
  /**
   * Base of that settlement backoff. Override with SETTLEMENT_RETRY_BASE_MS —
   * it is pacing, never a give-up threshold.
   */
  settlementRetryBaseMs?: number;
}

export interface OutboxDrainerHandle {
  stop(): void;
  drain(): Promise<number>;
}

/**
 * Start a background drainer that pulls outbox rows whose `processed_at`
 * is NULL and enqueues them on the matching BullMQ queue. Rows for
 * unknown queue names are logged and left pending so a deploy that adds
 * the missing queue still drains the backlog. Rows that have failed
 * `maxAttempts` times are skipped (dead-lettered) — a human will need
 * to clear `attempts` to retry them. EXCEPT settlement rows, which are
 * never dead-lettered: money is not something a retry counter may
 * abandon, so they keep retrying on a capped backoff and only get
 * louder (`outbox.settlement_stuck`).
 */
export function startOutboxDrainer(opts: OutboxDrainerOptions): OutboxDrainerHandle {
  const intervalMs = opts.intervalMs ?? Number(process.env.OUTBOX_DRAIN_INTERVAL_MS ?? 2000);
  const batchSize = opts.batchSize ?? Number(process.env.OUTBOX_DRAIN_BATCH_SIZE ?? 50);
  const maxAttempts = opts.maxAttempts ?? Number(process.env.MAX_OUTBOX_ATTEMPTS ?? 10);
  const retryBaseMs =
    opts.settlementRetryBaseMs ??
    Number(process.env.SETTLEMENT_RETRY_BASE_MS ?? SETTLEMENT_RETRY_BASE_MS);
  let stopped = false;

  async function drain(): Promise<number> {
    const startedAt = Date.now();
    const rows = await defaultDb
      .select()
      .from(outboxJobs)
      .where(
        and(
          isNull(outboxJobs.processedAt),
          // The dead-letter ceiling applies to everything EXCEPT money: a
          // settlement row stays eligible however many times it has failed.
          or(
            lt(outboxJobs.attempts, maxAttempts),
            inArray(outboxJobs.queueName, [...SETTLEMENT_QUEUES]),
          ),
          // Backoff gate. Only settlement rows ever set this, so non-money
          // pacing is unchanged.
          or(isNull(outboxJobs.nextAttemptAt), lte(outboxJobs.nextAttemptAt, sql`now()`)),
        ),
      )
      .orderBy(asc(outboxJobs.createdAt))
      .limit(batchSize);
    if (rows.length === 0) return 0;

    // Drain in parallel (#20). The UPDATE inside the success path is
    // guarded by `processed_at IS NULL`, so two drainers racing the
    // same row both write `attempts++` once and only one flips the
    // processed_at flag. Failures bump the counter via SQL so the
    // partial-pending index keeps doing its job.
    const results = await Promise.allSettled(rows.map((row) => processRow(row)));
    let processed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === 'processed') processed += 1;
    }
    const elapsedMs = Date.now() - startedAt;
    opts.log.info(
      { processed, queued: rows.length, elapsedMs, batchSize, maxAttempts },
      'outbox: drained',
    );
    return processed;
  }

  /**
   * Bump `attempts` (race-guarded on the row still being unprocessed) and, for a
   * settlement row, schedule its next try. Returns the new attempt count, or
   * null when a concurrent drainer already processed the row.
   */
  async function recordFailure(
    row: typeof outboxJobs.$inferSelect,
    lastError: string,
  ): Promise<number | null> {
    const backoffMs = settlementBackoffMs(row.attempts + 1, retryBaseMs);
    const updated = await defaultDb
      .update(outboxJobs)
      .set({
        attempts: sql`${outboxJobs.attempts} + 1`,
        lastError,
        ...(isSettlementQueue(row.queueName)
          ? {
              nextAttemptAt: sql`now() + make_interval(secs => ${backoffMs / 1000}::double precision)`,
            }
          : {}),
      })
      .where(and(eq(outboxJobs.id, row.id), isNull(outboxJobs.processedAt)))
      .returning({ attempts: outboxJobs.attempts });
    if (updated.length === 0) return null;
    return updated[0]?.attempts ?? row.attempts + 1;
  }

  /**
   * A row that has failed at least `maxAttempts` times. For ordinary queues that
   * is the end of the line (dead letter). For a settlement queue it is an ALERT,
   * not a verdict: the row stays eligible and keeps retrying, because dropping it
   * would strand the customer's credits. The backoff cap bounds this to one log
   * line per row per few minutes.
   */
  function logExhausted(
    row: typeof outboxJobs.$inferSelect,
    attempts: number,
    lastError: string,
  ): void {
    if (isSettlementQueue(row.queueName)) {
      opts.log.error(
        {
          event: 'outbox.settlement_stuck',
          rowId: row.id,
          queueName: row.queueName,
          attempts,
          lastError,
        },
        'outbox: settlement still failing past the dead-letter threshold — retrying anyway',
      );
      return;
    }
    opts.log.error(
      { event: 'outbox.dead_letter', rowId: row.id, queueName: row.queueName, attempts, lastError },
      'outbox: row dead-lettered after max attempts',
    );
  }

  async function processRow(
    row: typeof outboxJobs.$inferSelect,
  ): Promise<'processed' | 'pending' | 'skipped'> {
    const queue = opts.queues[row.queueName];
    if (!queue) {
      // Bump attempts so an unknown-queue row eventually dead-letters
      // instead of looping forever and starving real work out of the
      // batch. (A settlement row is never dropped — it backs off instead.)
      const reason = `no queue registered: ${row.queueName}`;
      const newAttempts = (await recordFailure(row, reason)) ?? row.attempts + 1;
      if (newAttempts >= maxAttempts) {
        if (row.queueName === AUTH_EMAIL_QUEUE) {
          await defaultDb
            .update(outboxJobs)
            .set({ payload: scrubProcessedOutboxPayload(row.queueName, row.payload) })
            .where(and(eq(outboxJobs.id, row.id), isNull(outboxJobs.processedAt)));
        }
        logExhausted(row, newAttempts, reason);
      } else {
        opts.log.warn(
          { rowId: row.id, queueName: row.queueName, attempts: newAttempts },
          'outbox: no queue registered for row',
        );
      }
      return 'skipped';
    }
    try {
      // Money jobs carry the settlement retry policy (BullMQ's default is a
      // SINGLE attempt, which would let one transient ledger blip permanently
      // fail a charge whose outbox row is already marked processed).
      const jobOptions = isSettlementQueue(row.queueName)
        ? { ...SETTLEMENT_JOB_OPTIONS }
        : { removeOnComplete: 100, removeOnFail: 100 };
      await queue.add(
        row.queueName,
        row.payload,
        row.jobId ? { ...jobOptions, jobId: row.jobId } : jobOptions,
      );
      const updated = await defaultDb
        .update(outboxJobs)
        .set({
          processedAt: sql`now()`,
          payload: scrubProcessedOutboxPayload(row.queueName, row.payload),
        })
        .where(and(eq(outboxJobs.id, row.id), isNull(outboxJobs.processedAt)))
        .returning({ id: outboxJobs.id });
      return updated.length > 0 ? 'processed' : 'skipped';
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 500) : 'unknown';
      // Race guard: if a concurrent drainer already flipped this row
      // to processed (success), DO NOT bump attempts — otherwise a
      // late-arriving local failure could push a succeeded row over
      // the dead-letter threshold.
      const newAttempts = await recordFailure(row, msg);
      if (newAttempts === null) {
        // The other drainer won — nothing to dead-letter.
        return 'pending';
      }
      if (newAttempts >= maxAttempts) {
        if (row.queueName === AUTH_EMAIL_QUEUE) {
          await defaultDb
            .update(outboxJobs)
            .set({ payload: scrubProcessedOutboxPayload(row.queueName, row.payload) })
            .where(and(eq(outboxJobs.id, row.id), isNull(outboxJobs.processedAt)));
        }
        logExhausted(row, newAttempts, msg);
      } else {
        opts.log.error(
          { err, rowId: row.id, queueName: row.queueName, attempts: newAttempts },
          'outbox: enqueue failed',
        );
      }
      return 'pending';
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await drain();
      } catch (err) {
        opts.log.error({ err }, 'outbox: drain loop error');
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, batchSize, maxAttempts }, 'outbox drainer started');

  return {
    stop(): void {
      stopped = true;
    },
    drain,
  };
}
