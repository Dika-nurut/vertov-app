import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { db, jobs, nid, outboxJobs, pool, scripts, scriptAssistRequests } from '@seed/db';
import { sweepStuckJobs, sweepExpiredScriptRequests } from './reaper';
import {
  seedUser,
  seedModel,
  seedJob,
  outboxFor,
  itId,
  cleanupIntegrationData,
} from './test-support/seed';

/**
 * The generation reaper guarantees every job reaches a TERMINAL status so the
 * client's poll can stop. Two stuck shapes leave credits reserved and the UI
 * spinning forever if unswept:
 *   - marooned-in-running: the worker crashed mid-call.
 *   - never-started-in-queue: the worker isn't consuming the queue (worker
 *     down) — previously unswept, so the job sat queued and the spinner never
 *     resolved.
 * Both must flip to `failed` + enqueue a refund. We exercise the pure sweep
 * directly; the Redis leader election that wraps it in production is proven by
 * its shared use across ticks.
 */
const log = pino({ level: 'silent' });
let userId: string;
let modelId: string;

async function setStatus(
  jobId: string,
  status: 'queued' | 'running',
  tsMsAgo: number,
): Promise<void> {
  const at = new Date(Date.now() - tsMsAgo);
  await db
    .update(jobs)
    .set(status === 'running' ? { status, startedAt: at } : { status, queuedAt: at })
    .where(eq(jobs.id, jobId));
}

/** Attach a composite provider handle to a job (simulates a submit that succeeded). */
async function setHandle(jobId: string, token: string): Promise<void> {
  await db.update(jobs).set({ providerJobId: token }).where(eq(jobs.id, jobId));
}

async function rowOf(jobId: string) {
  return (await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1))[0]!;
}

beforeAll(async () => {
  await cleanupIntegrationData();
  userId = await seedUser();
  modelId = await seedModel({ kind: 'image' });
});

afterAll(async () => {
  await cleanupIntegrationData();
  await pool.end();
});

describe('reaper — stuck generation jobs sweep to failed + refund', () => {
  it('reaps a job marooned in running past the running timeout', async () => {
    const { jobId } = await seedJob({ userId, modelId, creditsReserved: 50 });
    await setStatus(jobId, 'running', 30 * 60_000); // started 30m ago
    const n = await sweepStuckJobs(log, 5 * 60_000, 10 * 60_000);
    expect(n).toBeGreaterThanOrEqual(1);
    const row = await rowOf(jobId);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('TIMEOUT_REAPED');
    expect(row.finishedAt).not.toBeNull();
    // The reservation must be refunded via the outbox.
    const refund = (await outboxFor(jobId)).find((r) => r.jobId?.includes('refund-'));
    expect(refund).toBeTruthy();
  });

  it('reaps a job never picked up from the queue (worker down)', async () => {
    const { jobId } = await seedJob({ userId, modelId, creditsReserved: 70 });
    await setStatus(jobId, 'queued', 30 * 60_000); // queued 30m ago, never started
    await sweepStuckJobs(log, 15 * 60_000, 10 * 60_000); // 10m queued timeout
    const row = await rowOf(jobId);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('QUEUE_STALL_REAPED');
    const refund = (await outboxFor(jobId)).find((r) => r.jobId?.includes('refund-'));
    expect(refund).toBeTruthy();
  });

  /**
   * A retryable failure puts the job back in `queued` with its ORIGINAL `queued_at`,
   * because that column is the row's creation time everywhere else that reads it. The
   * reaper therefore saw a job that had merely been ALIVE for thirty minutes as one that
   * had never been picked up, and refunded it inside the eight-second window before
   * BullMQ's own retry ran. The customer lost a job that was one attempt from delivering.
   */
  it('leaves a REQUEUED job alone even when it was first submitted long ago', async () => {
    const { jobId } = await seedJob({ userId, modelId, creditsReserved: 40 });
    await db
      .update(jobs)
      .set({
        status: 'queued',
        queuedAt: new Date(Date.now() - 30 * 60_000), // submitted 30m ago
        requeuedAt: new Date(Date.now() - 8_000), // BullMQ retry lands in ~8s
        startedAt: null,
      })
      .where(eq(jobs.id, jobId));
    await sweepStuckJobs(log, 15 * 60_000, 10 * 60_000);
    expect((await rowOf(jobId)).status).toBe('queued');
    expect((await outboxFor(jobId)).find((r) => r.jobId?.includes('refund-'))).toBeFalsy();
  });

  it('still reaps a REQUEUED job once the retry itself goes stale', async () => {
    // The guard shifts the clock; it does not remove it. A requeue nobody consumed is
    // exactly the stall this reaper exists for.
    const { jobId } = await seedJob({ userId, modelId, creditsReserved: 40 });
    await db
      .update(jobs)
      .set({
        status: 'queued',
        queuedAt: new Date(Date.now() - 60 * 60_000),
        requeuedAt: new Date(Date.now() - 30 * 60_000),
        startedAt: null,
      })
      .where(eq(jobs.id, jobId));
    await sweepStuckJobs(log, 15 * 60_000, 10 * 60_000);
    const row = await rowOf(jobId);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('QUEUE_STALL_REAPED');
  });

  it('leaves a fresh queued job alone (within the queued timeout)', async () => {
    const { jobId } = await seedJob({ userId, modelId });
    await setStatus(jobId, 'queued', 30_000); // queued 30s ago
    await sweepStuckJobs(log, 15 * 60_000, 10 * 60_000);
    expect((await rowOf(jobId)).status).toBe('queued');
  });

  it('leaves a fresh running job alone (within the running timeout)', async () => {
    const { jobId } = await seedJob({ userId, modelId });
    await setStatus(jobId, 'running', 60_000); // started 1m ago
    await sweepStuckJobs(log, 15 * 60_000, 10 * 60_000);
    expect((await rowOf(jobId)).status).toBe('running');
  });
});

describe('reaper — PRF-4: marooned running rows with a bindable handle resume, not refund', () => {
  const ARMED = {
    OPENROUTER_MODE: 'live',
    OPENROUTER_API_KEY: 'sk-reaper-test',
  } as const;

  it('requeues a marooned job whose composite handle binds an armed gateway — no refund', async () => {
    const savedEnv = { ...process.env };
    Object.assign(process.env, ARMED);
    try {
      const { jobId } = await seedJob({ userId, modelId, creditsReserved: 60 });
      await setStatus(jobId, 'running', 30 * 60_000);
      await setHandle(jobId, 'openrouter::bytedance/seedance-2.0');
      await sweepStuckJobs(log, 5 * 60_000, 10 * 60_000);
      const row = await rowOf(jobId);
      expect(row.status).toBe('queued');
      expect(row.errorCode).toBeNull();
      expect(row.requeuedAt).not.toBeNull();
      expect(row.startedAt).toBeNull();
      // The reservation is still held — no refund may be enqueued.
      expect((await outboxFor(jobId)).some((r) => r.jobId?.includes('refund-'))).toBe(false);
      // The handle survived (runJob's resume path needs it).
      expect(row.providerJobId).toBe('openrouter::bytedance/seedance-2.0');
    } finally {
      process.env = savedEnv;
    }
  });

  it('still refunds a marooned job when the gateway is NOT live-armed (stub would bind)', async () => {
    const savedEnv = { ...process.env };
    delete process.env.OPENROUTER_MODE;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const { jobId } = await seedJob({ userId, modelId, creditsReserved: 61 });
      await setStatus(jobId, 'running', 30 * 60_000);
      await setHandle(jobId, 'openrouter::bytedance/seedance-2.0');
      await sweepStuckJobs(log, 5 * 60_000, 10 * 60_000);
      const row = await rowOf(jobId);
      expect(row.status).toBe('failed');
      expect(row.errorCode).toBe('TIMEOUT_REAPED');
      expect((await outboxFor(jobId)).some((r) => r.jobId?.includes('refund-'))).toBe(true);
    } finally {
      process.env = savedEnv;
    }
  });

  it('refunds on the SECOND maroon — recovery is bounded to one requeue per job', async () => {
    const savedEnv = { ...process.env };
    Object.assign(process.env, ARMED);
    try {
      const { jobId } = await seedJob({ userId, modelId, creditsReserved: 62 });
      await db
        .update(jobs)
        .set({ requeuedAt: new Date(Date.now() - 40 * 60_000) })
        .where(eq(jobs.id, jobId));
      await setStatus(jobId, 'running', 30 * 60_000);
      await setHandle(jobId, 'openrouter::bytedance/seedance-2.0');
      await sweepStuckJobs(log, 5 * 60_000, 10 * 60_000);
      const row = await rowOf(jobId);
      expect(row.status).toBe('failed');
      expect(row.errorCode).toBe('TIMEOUT_REAPED');
      expect((await outboxFor(jobId)).some((r) => r.jobId?.includes('refund-'))).toBe(true);
    } finally {
      process.env = savedEnv;
    }
  });

  it('refunds a marooned job with a legacy bare provider id (no gateway binding)', async () => {
    const savedEnv = { ...process.env };
    Object.assign(process.env, ARMED);
    try {
      const { jobId } = await seedJob({ userId, modelId, creditsReserved: 63 });
      await setStatus(jobId, 'running', 30 * 60_000);
      await setHandle(jobId, 'pred-bare-legacy-id');
      await sweepStuckJobs(log, 5 * 60_000, 10 * 60_000);
      const row = await rowOf(jobId);
      expect(row.status).toBe('failed');
      expect(row.errorCode).toBe('TIMEOUT_REAPED');
    } finally {
      process.env = savedEnv;
    }
  });
});

describe('reaper — crashed paid Scenario request claims settle + refund', () => {
  async function seedClaim(opts: {
    reserved: boolean;
    ageMs: number;
    updatedMsAgo?: number;
    amount?: number;
    op?: string;
    forUser?: string;
  }): Promise<{ claimId: string; jobId: string }> {
    const owner = opts.forUser ?? userId;
    const scriptId = itId('script');
    await db.insert(scripts).values({ id: scriptId, userId: owner, title: 'Тест' });
    const claimId = itId('claim');
    const jobId = itId('sjob');
    await db.insert(scriptAssistRequests).values({
      id: claimId,
      scriptId,
      userId: owner,
      idempotencyKey: `k-${nid()}`,
      jobId,
      amount: opts.amount ?? 4,
      reserved: opts.reserved,
      op: opts.op ?? 'structurize',
      status: 'in_progress',
      createdAt: new Date(Date.now() - opts.ageMs),
      updatedAt: new Date(Date.now() - (opts.updatedMsAgo ?? opts.ageMs)),
    });
    return { claimId, jobId };
  }
  const claimRow = async (claimId: string) =>
    (await db.select().from(scriptAssistRequests).where(eq(scriptAssistRequests.id, claimId)))[0];

  it('reaps a crashed RESERVED claim: deletes the row and refunds the exact reserved amount', async () => {
    const { claimId, jobId } = await seedClaim({ reserved: true, ageMs: 20 * 60_000, amount: 4 });
    const n = await sweepExpiredScriptRequests(log, 10 * 60_000);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await claimRow(claimId)).toBeUndefined(); // deleted
    const refund = (await outboxFor(jobId)).find((r) => r.queueName === 'credits.refund');
    expect(refund, 'a refund must be enqueued for the hold').toBeTruthy();
    const payload = refund!.payload as { amount: number; idempotencyKey: string; jobId: string };
    expect(payload.amount).toBe(4);
    expect(payload.jobId).toBe(jobId);
    expect(payload.idempotencyKey).toBe(`structurize:${jobId}:refund`); // canonical key
  });

  it('reaps a crashed UNRESERVED claim: deletes the row, enqueues NO refund (no hold existed)', async () => {
    const { claimId, jobId } = await seedClaim({ reserved: false, ageMs: 20 * 60_000 });
    await sweepExpiredScriptRequests(log, 10 * 60_000);
    expect(await claimRow(claimId)).toBeUndefined(); // deleted (frees the in-flight slot)
    const refund = (await outboxFor(jobId)).find((r) => r.queueName === 'credits.refund');
    expect(refund).toBeUndefined(); // nothing to refund
  });

  it('leaves a fresh in-flight claim alone (within the stale window)', async () => {
    const { claimId } = await seedClaim({
      reserved: true,
      ageMs: 60_000,
      forUser: await seedUser(),
    }); // 1m old
    await sweepExpiredScriptRequests(log, 10 * 60_000);
    expect((await claimRow(claimId))?.status).toBe('in_progress');
  });

  it('does NOT reap live-but-slow work: old createdAt but a fresh updatedAt lease', async () => {
    // Created 30m ago, but the lease was refreshed 30s ago (the route bumps
    // updatedAt before the provider call) → still live, must be left alone.
    const { claimId } = await seedClaim({
      reserved: true,
      ageMs: 30 * 60_000,
      updatedMsAgo: 30_000,
      forUser: await seedUser(),
    });
    await sweepExpiredScriptRequests(log, 10 * 60_000);
    expect((await claimRow(claimId))?.status).toBe('in_progress');
  });

  it('quarantines (does NOT delete) an expired RESERVED row missing jobId — preserves recovery evidence', async () => {
    // Isolated user so the "no refund" assertion isn't affected by other tests.
    const isoUser = await seedUser();
    const scriptId = itId('script');
    await db.insert(scripts).values({ id: scriptId, userId: isoUser, title: 'Тест' });
    const claimId = itId('claim');
    await db.insert(scriptAssistRequests).values({
      id: claimId,
      scriptId,
      userId: isoUser,
      idempotencyKey: `k-${nid()}`,
      jobId: null, // malformed: reserved but no reservation handle
      amount: null,
      reserved: true,
      op: 'structurize',
      status: 'in_progress',
      createdAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(Date.now() - 20 * 60_000),
    });

    await sweepExpiredScriptRequests(log, 10 * 60_000);

    const row = await claimRow(claimId);
    expect(row, 'the malformed reserved row must NOT be deleted').toBeTruthy();
    expect(row!.status).toBe('failed');
    expect(row!.failure).toBe('reaper_unreconcilable');
    // No refund enqueued (we have no jobId to key it on) — nothing stranded silently.
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, 'credits.refund'));
    expect(refunds.some((r) => (r.payload as { userId?: string }).userId === isoUser)).toBe(false);
  });

  it("also settles a crashed ASSIST hold, using assist's canonical refund key", async () => {
    const { claimId, jobId } = await seedClaim({
      reserved: true,
      ageMs: 20 * 60_000,
      amount: 7,
      op: 'assist',
    });
    await sweepExpiredScriptRequests(log, 10 * 60_000);
    expect(await claimRow(claimId)).toBeUndefined();
    const refund = (await outboxFor(jobId)).find((r) => r.queueName === 'credits.refund');
    expect(refund, 'a crashed assist hold must be refunded').toBeTruthy();
    const payload = refund!.payload as { amount: number; idempotencyKey: string };
    expect(payload.amount).toBe(7);
    expect(payload.idempotencyKey).toBe(`assist:${jobId}:refund`); // matches the assist route's key
  });
});
