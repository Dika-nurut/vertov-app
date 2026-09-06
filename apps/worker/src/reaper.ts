import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, jobs, scriptAssistRequests, sweepUnsettledOfficialLegSpend } from '@seed/db';
import { getResumeAdapter } from '@seed/provider-byteplus';
import { parseResumeToken } from './resume-token';
import { CREDIT_REFUND_QUEUE, enqueueViaOutbox, paidScriptClaimKey } from '@seed/credits';
import { publishJobEvent } from './events';
import { reaperReapedTotal } from './metrics';

/**
 * Deferred W1.Fri review item #6: jobs that flip to `running` but never
 * finish (worker crash, network split, hung BytePlus call) sit forever
 * holding pending credits. Sweeper flips anything with
 * `status='running'` and `startedAt < now() - RUNNING_TIMEOUT_MS` to
 * `failed (TIMEOUT_REAPED)` and enqueues a refund. Atomic UPDATE …
 * RETURNING avoids racing with the live runner — only rows that were
 * still `running` at this exact instant move.
 *
 * Multi-instance contention (#12): with N workers each running their
 * own reaper, the harmless-but-wasteful pattern is every instance
 * racing the same UPDATE. We elect a leader per tick via a short-TTL
 * Redis lock (SET NX PX). The lock TTL is intervalMs * 2 so a crashing
 * leader doesn't block the next tick. Inside the holder we still rely
 * on the atomic UPDATE for correctness.
 */
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
// Jobs that sit in `queued` past this never started running — the worker isn't
// consuming the queue (worker down, queue wedged). Left alone they hold pending
// credits forever and the client spins indefinitely. Reap + refund them too.
const DEFAULT_QUEUED_TIMEOUT_MS = 10 * 60_000;
// Paid Scenario request (assist/structurize) claims that sit `in_progress` past
// this are crashed handlers — the call deadline is 120s, so 10 min is
// unambiguously dead. The lazy per-request reclaim only fires when the SAME user
// returns; this sweep settles holds for users who never come back.
const DEFAULT_SCRIPT_REQUEST_STALE_MS = 10 * 60_000;
const LEADER_KEY = 'seed:reaper:leader';

export interface ReaperOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  timeoutMs?: number;
  queuedTimeoutMs?: number;
  scriptRequestStaleMs?: number;
}

export interface ReaperHandle {
  stop(): void;
  tick(): Promise<number>;
}

/**
 * Pure sweep: flip every stuck job to `failed` + enqueue a refund, in one tx.
 * Two stuck shapes, both leaving credits reserved and the client polling
 * forever if left alone:
 *   - marooned-in-running: worker crashed mid-call (`startedAt` past timeout).
 *   - never-started-in-queue: worker isn't consuming (`queuedAt` past timeout).
 * Both atomic UPDATEs race-safely with the live runner — the runner only claims
 * rows still `status='queued'` (job-runner conditional update), so a job this
 * sweep already failed can't be resurrected. Exported (Redis-free) so it's
 * directly testable; the Redis leader election lives in `tick`.
 *
 * The same tx also finalizes the third leg's ₽ for every job that has FINISHED
 * with a reservation still open — including the ones just flipped above. Credits
 * were the only money this sweep used to return: a worker killed after the
 * official leg submitted left a reservation nothing would ever settle, because
 * the settlement lives in the runner that died. (The existing "reaper wins"
 * spec never tested that — it flips the status while a live runner keeps going,
 * and that runner does the settling.) Running every tick is also the retry
 * behind a settlement transaction that failed and was never redelivered.
 */

/**
 * True when {@link getResumeAdapter} would hand back the zero-spend stub —
 * i.e. the gateway is not live-armed. Exported for tests.
 */
export function isStubResume(
  gateway: string,
  env: Parameters<typeof getResumeAdapter>[1],
): boolean {
  let adapter: unknown;
  try {
    adapter = getResumeAdapter(gateway, env);
  } catch {
    return true; // a gateway that refuses to build cannot bind a handle
  }
  if (adapter == null) return true;
  // Avoid importing the stub class into a type cycle: structural duck-check on
  // the stub's deterministic sample-asset marker via its name.
  return adapter.constructor?.name === 'StubBytePlusAdapter';
}

export async function sweepStuckJobs(
  log: Logger,
  timeoutMs: number,
  queuedTimeoutMs: number,
): Promise<number> {
  const now = Date.now();
  const runningCutoff = new Date(now - timeoutMs);
  const queuedCutoff = new Date(now - queuedTimeoutMs);
  // Flip job + write refund outbox row in ONE tx (#4). Direct
  // `refundQueue.add()` here could lose the refund on a Redis hiccup — the job
  // was already marked failed, so the user's reservation would silently leak.
  // Outbox closes that window.
  const reaped = await db.transaction(async (tx) => {
    const flip = (where: ReturnType<typeof and>, code: string, message: string) =>
      tx
        .update(jobs)
        .set({ status: 'failed', errorCode: code, errorMessage: message, finishedAt: sql`now()` })
        .where(where)
        .returning({
          id: jobs.id,
          userId: jobs.userId,
          creditsReserved: jobs.creditsReserved,
        });

    // PRF-4: a marooned running row with a BINDABLE provider handle is worth
    // resuming, not refunding — the vendor may already have billed us, and the
    // at-most-once protocol can settle the paid attempt honestly by polling the
    // SAME handle (runJob's resume path does exactly this on an orderly retry).
    // The handle is bindable when its composite token parses AND
    // `getResumeAdapter` builds an armed adapter for that gateway (the same
    // unarmed-null rule the runner applies — an unarmed gateway must never
    // re-enter the queue only to die again at claim time).
    // Bound to ONE recovery per job: only a first running stint qualifies
    // (`requeuedAt IS NULL`). Any job that already re-entered the queue once —
    // via a retryable failure or an earlier recovery — refunds as before, so a
    // repeatedly-crashing worker cannot maroon→requeue the same job forever.
    const marooned = await tx
      .select({
        id: jobs.id,
        providerJobId: jobs.providerJobId,
        requeuedAt: jobs.requeuedAt,
      })
      .from(jobs)
      .where(and(eq(jobs.status, 'running'), lt(jobs.startedAt, runningCutoff)));
    const resumable = marooned.filter(
      (row) =>
        row.requeuedAt == null &&
        row.providerJobId != null &&
        parseResumeToken(row.providerJobId) != null &&
        // Not just non-null: an UNARMED gateway builds a zero-spend stub
        // (getAdapter's dev/test convenience), and requeueing onto a stub would
        // hand the job a fake asset or a fresh StubProviderForbidden at claim
        // time. Only an armed (non-stub) adapter binds the handle.
        !isStubResume(
          parseResumeToken(row.providerJobId)!.gateway,
          process.env as Parameters<typeof getResumeAdapter>[1],
        ),
    );
    if (resumable.length > 0) {
      const revived = await tx
        .update(jobs)
        .set({ status: 'queued', startedAt: null, requeuedAt: new Date() })
        .where(
          and(
            eq(jobs.status, 'running'),
            lt(jobs.startedAt, runningCutoff),
            inArray(
              jobs.id,
              resumable.map((row) => row.id),
            ),
          ),
        )
        .returning({ id: jobs.id, userId: jobs.userId });
      for (const row of revived) {
        log.warn(
          { jobId: row.id },
          'reaper: requeued marooned job with a bindable provider handle (PRF-4)',
        );
        publishJobEvent({
          userId: row.userId,
          jobId: row.id,
          status: 'queued',
          source: 'generation',
        });
      }
    }
    const rows = [
      ...(await flip(
        and(
          eq(jobs.status, 'running'),
          lt(jobs.startedAt, runningCutoff),
          // Everything the fork above just requeued has left `running`; the
          // remaining marooned rows (unbindable handle, non-resumable gateway,
          // or second maroon) still refund exactly as before.
          resumable.length > 0
            ? sql`${jobs.id} NOT IN (${sql.join(
                resumable.map((r) => sql`${r.id}`),
                sql`, `,
              )})`
            : sql`true`,
        ),
        'TIMEOUT_REAPED',
        `Job exceeded running timeout (${timeoutMs}ms).`,
      )),
      ...(await flip(
        and(
          eq(jobs.status, 'queued'),
          // Time in the CURRENT queued state, not since submission. A job that ran for
          // nine minutes and then hit a retryable error re-enters the queue with its
          // original `queued_at`; measuring from that reaped and refunded it on the next
          // tick while BullMQ's own retry was still in flight, so a job one attempt from
          // delivering was killed. `queued_at` cannot simply be reset — it is the row's
          // creation time everywhere else that reads it.
          lt(sql`coalesce(${jobs.requeuedAt}, ${jobs.queuedAt})`, queuedCutoff),
        ),
        'QUEUE_STALL_REAPED',
        `Job never started: queue not consumed within ${queuedTimeoutMs}ms.`,
      )),
    ];

    for (const row of rows) {
      await enqueueViaOutbox({
        tx,
        queueName: CREDIT_REFUND_QUEUE,
        jobId: `refund-${row.id}`,
        payload: {
          userId: row.userId,
          jobId: row.id,
          amount: row.creditsReserved,
          reason: 'reaper.timeout',
          idempotencyKey: `job:${row.id}:refund`,
        },
      });
    }
    // Ordered after the flips so a job reaped this very tick has its official-leg
    // reservation closed in the same transaction as its credit refund.
    const orphans = await sweepUnsettledOfficialLegSpend(tx);
    if (orphans > 0) {
      log.warn(
        { attempts: orphans },
        'reaper: finalized official-leg reservations left open by a job that already finished',
      );
    }
    return rows;
  });

  for (const row of reaped) {
    publishJobEvent({ userId: row.userId, jobId: row.id, status: 'failed', source: 'generation' });
  }
  if (reaped.length > 0) {
    log.warn({ count: reaped.length, timeoutMs, queuedTimeoutMs }, 'reaper: timed out stuck jobs');
  }
  return reaped.length;
}

/**
 * Sweep crashed paid Scenario request claims (assist/structurize) and settle
 * them. In ONE transaction: DELETE every `in_progress` claim older than `staleMs`
 * (freeing its per-user/op in-flight slot) and, for those that actually RESERVED
 * a hold, enqueue a refund via the outbox — keyed by the SAME canonical
 * `paidScriptClaimKey(op, jobId, 'refund')` the route/lazy-reclaim would use, so
 * if the handler or a lazy reclaim already refunded, the ledger dedupes (no
 * double refund, no dead-letter). A claim that crashed BEFORE reserving has
 * reserved=false → deleted with no (doomed) refund.
 *
 * Only rows older than staleMs (≫ the 120s call deadline) are touched, so a
 * live-but-slow handler is never reaped; even if it were, its fenced updates
 * would then find no row and abort. This mirrors the route's lazy reclaim exactly
 * — it just runs on a schedule for users who never return. Exported (Redis-free)
 * so it's directly testable.
 */
export async function sweepExpiredScriptRequests(log: Logger, staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const reaped = await db.transaction(async (tx) => {
    // Quarantine (do NOT delete) any expired reserved row we cannot refund — its
    // jobId/amount are the only handle on a real ledger hold, so deleting would
    // strand the money with no recovery evidence. (Impossible from current code,
    // which sets reserved atomically with jobId+amount; defends corruption/skew.)
    const quarantined = await tx
      .update(scriptAssistRequests)
      .set({ status: 'failed', failure: 'reaper_unreconcilable', updatedAt: sql`now()` })
      .where(
        and(
          eq(scriptAssistRequests.status, 'in_progress'),
          lt(scriptAssistRequests.updatedAt, cutoff),
          eq(scriptAssistRequests.reserved, true),
          sql`(${scriptAssistRequests.jobId} IS NULL OR ${scriptAssistRequests.amount} IS NULL)`,
        ),
      )
      .returning({ id: scriptAssistRequests.id });
    for (const row of quarantined) {
      log.error(
        { id: row.id },
        'reaper: reserved script claim missing jobId/amount — quarantined for manual audit',
      );
    }

    // Everything else expired is safe to delete + settle. Expiry is on updatedAt
    // (a lease the routes refresh at reserve and before the provider call), so a
    // live-but-slow request is never reaped mid-flight.
    const rows = await tx
      .delete(scriptAssistRequests)
      .where(
        and(
          eq(scriptAssistRequests.status, 'in_progress'),
          lt(scriptAssistRequests.updatedAt, cutoff),
        ),
      )
      .returning({
        userId: scriptAssistRequests.userId,
        jobId: scriptAssistRequests.jobId,
        amount: scriptAssistRequests.amount,
        reserved: scriptAssistRequests.reserved,
        op: scriptAssistRequests.op,
      });
    for (const row of rows) {
      if (!row.reserved || !row.jobId || row.amount == null) continue; // no settleable hold
      await enqueueViaOutbox({
        tx,
        queueName: CREDIT_REFUND_QUEUE,
        jobId: `${row.op}-refund-${row.jobId}`,
        payload: {
          userId: row.userId,
          jobId: row.jobId,
          amount: row.amount,
          reason: 'reaper.script_request_expired',
          idempotencyKey: paidScriptClaimKey(row.op, row.jobId, 'refund'),
        },
      });
    }
    return { settled: rows.length, quarantined: quarantined.length };
  });
  const total = reaped.settled + reaped.quarantined;
  if (total > 0) {
    log.warn(
      { ...reaped, staleMs },
      'reaper: settled/quarantined crashed paid script-request claims',
    );
  }
  return total;
}

export function startReaper(opts: ReaperOptions): ReaperHandle {
  const intervalMs =
    opts.intervalMs ?? Number(process.env.JOB_REAPER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.JOB_RUNNING_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const queuedTimeoutMs =
    opts.queuedTimeoutMs ?? Number(process.env.JOB_QUEUED_TIMEOUT_MS ?? DEFAULT_QUEUED_TIMEOUT_MS);
  const scriptRequestStaleMs =
    opts.scriptRequestStaleMs ??
    Number(process.env.SCRIPT_REQUEST_STALE_MS ?? DEFAULT_SCRIPT_REQUEST_STALE_MS);
  const instanceId = randomUUID();

  let stopped = false;

  async function tick(): Promise<number> {
    // Leader election: only one reaper across N workers proceeds per tick.
    // The atomic UPDATE inside is still safe for the rare case where the
    // lock TTL expires under load and two ticks overlap.
    //
    // TTL must be SHORTER than intervalMs, otherwise the leader's own
    // lock survives into the next tick and the reaper effectively runs
    // at half rate. We aim the TTL so it expires comfortably before
    // the next tick fires.
    const lockTtl = Math.max(500, Math.floor(intervalMs * 0.8));
    const acquired = await opts.redis.set(LEADER_KEY, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') {
      opts.log.debug({ instanceId }, 'reaper: skipping tick (not leader)');
      return 0;
    }

    const reaped = await sweepStuckJobs(opts.log, timeoutMs, queuedTimeoutMs);
    if (reaped > 0) reaperReapedTotal.labels('generation').inc(reaped);

    // Same leader tick also settles crashed paid Scenario request holds (separate
    // table + refund key, but shared scheduling/leadership/metrics — correctness
    // still lives in the atomic delete+outbox transition inside the sweep).
    const scriptReaped = await sweepExpiredScriptRequests(opts.log, scriptRequestStaleMs);
    if (scriptReaped > 0) reaperReapedTotal.labels('script_request').inc(scriptReaped);

    return reaped + scriptReaped;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        opts.log.error({ err }, 'reaper tick failed');
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  void loop();

  opts.log.info(
    { intervalMs, timeoutMs, queuedTimeoutMs, scriptRequestStaleMs, instanceId },
    'reaper started',
  );

  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
