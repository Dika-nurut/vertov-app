import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { and, eq, like } from 'drizzle-orm';
import {
  creditTransactions,
  db,
  nid,
  outboxJobs,
  pool,
  scripts,
  scriptAssistRequests,
} from '@seed/db';
import {
  CREDIT_COMMIT_QUEUE,
  CREDIT_REFUND_QUEUE,
  creditService,
  enqueueViaOutbox,
  paidScriptClaimKey,
} from '@seed/credits';
import { sweepExpiredScriptRequests } from './reaper';
import { cleanupIntegrationData, itId, seedUser } from './test-support/seed';

const log = pino({ level: 'silent' });
const STARTING_BALANCE = 100;
const COST = 7;

type SettlementPayload = {
  userId: string;
  jobId: string;
  amount: number;
  idempotencyKey: string;
  reason: string;
};

async function seedHeldClaim(opts: {
  stale: boolean;
  op?: 'assist' | 'structurize' | 'prompt_studio';
}) {
  const userId = await seedUser();
  const scriptId = itId('money-script');
  const claimId = itId('money-claim');
  const jobId = itId('money-job');
  const op = opts.op ?? 'structurize';
  const updatedAt = new Date(Date.now() - (opts.stale ? 20 * 60_000 : 30_000));

  await creditService.grant({
    userId,
    amount: STARTING_BALANCE,
    reason: 'adversarial.seed',
    account: 'pack_grant',
    idempotencyKey: `${claimId}:grant`,
  });
  await db.transaction(async (tx) => {
    await tx.insert(scripts).values({ id: scriptId, userId, title: 'Money race' });
    await tx.insert(scriptAssistRequests).values({
      id: claimId,
      scriptId,
      userId,
      idempotencyKey: `${claimId}:request`,
      jobId,
      amount: COST,
      op,
      status: 'in_progress',
      reserved: false,
      createdAt: updatedAt,
      updatedAt,
    });
    await creditService.reserve({
      userId,
      jobId,
      amount: COST,
      reason: `script.${op}`,
      idempotencyKey: paidScriptClaimKey(op, jobId, 'reserve'),
      tx,
    });
    await tx
      .update(scriptAssistRequests)
      .set({ reserved: true, amount: COST, updatedAt })
      .where(eq(scriptAssistRequests.id, claimId));
  });
  expect(await creditService.balanceFor(userId)).toEqual({
    available: STARTING_BALANCE - COST,
    pending: COST,
  });
  return { userId, scriptId, claimId, jobId, op };
}

async function outboxFor(jobId: string) {
  return db
    .select()
    .from(outboxJobs)
    .where(like(outboxJobs.jobId, `%${jobId}%`));
}

async function ledgerFor(userId: string, jobId: string) {
  return db
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.relatedJobId, jobId)));
}

async function replayMany(kind: 'commit' | 'refund', payload: SettlementPayload, copies = 16) {
  const settle = () =>
    kind === 'commit' ? creditService.commit(payload) : creditService.refund(payload);
  const raced = await Promise.allSettled(Array.from({ length: copies }, settle));
  expect(raced.some((result) => result.status === 'fulfilled')).toBe(true);
  // A retry after any concurrent loser must resolve idempotently to the same legs.
  await settle();
  return raced;
}

beforeEach(async () => {
  await cleanupIntegrationData();
});

afterAll(async () => {
  await cleanupIntegrationData();
  await pool.end();
});

describe('adversarial paid Scenario money path', () => {
  it('completion holding the claim lock beats the reaper; duplicate commit delivery charges exactly once', async () => {
    const held = await seedHeldClaim({ stale: true });
    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const release = new Promise<void>((resolve) => (releaseLock = resolve));

    const completion = db.transaction(async (tx) => {
      const owned = await tx
        .update(scriptAssistRequests)
        .set({ status: 'completed', result: { format: 'short_vertical' } })
        .where(
          and(
            eq(scriptAssistRequests.id, held.claimId),
            eq(scriptAssistRequests.status, 'in_progress'),
          ),
        )
        .returning({ id: scriptAssistRequests.id });
      expect(owned).toHaveLength(1);
      signalLocked();
      await release;
      await enqueueViaOutbox({
        tx,
        queueName: CREDIT_COMMIT_QUEUE,
        jobId: `structurize-commit-${held.jobId}`,
        payload: {
          userId: held.userId,
          jobId: held.jobId,
          amount: COST,
          reason: 'script.structurize.commit',
          idempotencyKey: paidScriptClaimKey('structurize', held.jobId, 'commit'),
        },
      });
    });

    await locked;
    const reaper = sweepExpiredScriptRequests(log, 10 * 60_000);
    // Give the DELETE a chance to contend on the row lock held by completion.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLock();
    await completion;
    expect(await reaper).toBe(0);

    const rows = await outboxFor(held.jobId);
    expect(rows.map((row) => row.queueName)).toEqual([CREDIT_COMMIT_QUEUE]);
    const payload = rows[0]!.payload as SettlementPayload;
    await replayMany('commit', payload);

    expect(await creditService.balanceFor(held.userId)).toEqual({
      available: STARTING_BALANCE - COST,
      pending: 0,
    });
    const ledger = await ledgerFor(held.userId, held.jobId);
    expect(ledger.filter((row) => row.account === 'spend')).toHaveLength(1);
    expect(ledger.filter((row) => row.account === 'refund')).toHaveLength(0);
    expect(ledger.filter((row) => row.account === 'pending')).toHaveLength(2);
  });

  it('reaper and lazy reclaim race for one crashed hold; duplicate refund delivery releases exactly once', async () => {
    const held = await seedHeldClaim({ stale: true });
    const lazyReclaim = db.transaction(async (tx) => {
      const removed = await tx
        .delete(scriptAssistRequests)
        .where(
          and(
            eq(scriptAssistRequests.id, held.claimId),
            eq(scriptAssistRequests.status, 'in_progress'),
            eq(scriptAssistRequests.op, 'structurize'),
          ),
        )
        .returning({ jobId: scriptAssistRequests.jobId });
      if (removed.length === 0) return 0;
      await enqueueViaOutbox({
        tx,
        queueName: CREDIT_REFUND_QUEUE,
        jobId: `structurize-refund-${held.jobId}`,
        payload: {
          userId: held.userId,
          jobId: held.jobId,
          amount: COST,
          reason: 'script.structurize.stale_reclaim',
          idempotencyKey: paidScriptClaimKey('structurize', held.jobId, 'refund'),
        },
      });
      return 1;
    });

    const [lazyCount, reaperCount] = await Promise.all([
      lazyReclaim,
      sweepExpiredScriptRequests(log, 10 * 60_000),
    ]);
    expect(lazyCount + reaperCount).toBe(1);
    expect(
      await db.select().from(scriptAssistRequests).where(eq(scriptAssistRequests.id, held.claimId)),
    ).toHaveLength(0);

    const rows = (await outboxFor(held.jobId)).filter(
      (row) => row.queueName === CREDIT_REFUND_QUEUE,
    );
    expect(rows).toHaveLength(1);
    await replayMany('refund', rows[0]!.payload as SettlementPayload);

    expect(await creditService.balanceFor(held.userId)).toEqual({
      available: STARTING_BALANCE,
      pending: 0,
    });
    const ledger = await ledgerFor(held.userId, held.jobId);
    expect(ledger.filter((row) => row.account === 'refund')).toHaveLength(1);
    expect(ledger.filter((row) => row.account === 'spend')).toHaveLength(0);
    expect(ledger.filter((row) => row.account === 'pending')).toHaveLength(2);
  });

  it('opposite commit/refund settlements racing on one hold cannot both land', async () => {
    for (let iteration = 0; iteration < 12; iteration++) {
      const held = await seedHeldClaim({
        stale: false,
        op: iteration % 2 ? 'assist' : 'structurize',
      });
      const commit: SettlementPayload = {
        userId: held.userId,
        jobId: held.jobId,
        amount: COST,
        reason: `script.${held.op}.commit`,
        idempotencyKey: paidScriptClaimKey(held.op, held.jobId, 'commit'),
      };
      const refund: SettlementPayload = {
        userId: held.userId,
        jobId: held.jobId,
        amount: COST,
        reason: `script.${held.op}.refund`,
        idempotencyKey: paidScriptClaimKey(held.op, held.jobId, 'refund'),
      };
      const results = await Promise.allSettled([
        creditService.commit(commit),
        creditService.refund(refund),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      const ledger = await ledgerFor(held.userId, held.jobId);
      const spends = ledger.filter((row) => row.account === 'spend');
      const refunds = ledger.filter((row) => row.account === 'refund');
      expect(spends.length + refunds.length).toBe(1);
      expect(ledger.filter((row) => row.account === 'pending')).toHaveLength(2);
      expect((await creditService.balanceFor(held.userId)).pending).toBe(0);
      expect((await creditService.balanceFor(held.userId)).available).toBe(
        spends.length === 1 ? STARTING_BALANCE - COST : STARTING_BALANCE,
      );
    }
  });

  it('a crashed prompt_studio claim is settled by the reaper under the key its route computes', async () => {
    // /v1/prompt-studio/draft leaves the claim in_progress + reserved whenever it
    // cannot make the refund durable itself. That is only safe if the reaper can
    // finish the job — and only if both parties key the settlement identically.
    const held = await seedHeldClaim({ stale: true, op: 'prompt_studio' });

    expect(await sweepExpiredScriptRequests(log, 10 * 60_000)).toBe(1);

    // The claim is deleted (freeing the user's in-flight slot) and its hold is
    // durably owed rather than silently dropped.
    expect(
      await db.select().from(scriptAssistRequests).where(eq(scriptAssistRequests.id, held.claimId)),
    ).toHaveLength(0);
    const rows = (await outboxFor(held.jobId)).filter(
      (row) => row.queueName === CREDIT_REFUND_QUEUE,
    );
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as SettlementPayload;
    // The exact key the route uses for its own inline/outbox refund, so whichever
    // settles first the other dedupes instead of hitting the reservation guard.
    expect(payload.idempotencyKey).toBe(`prompt_studio:${held.jobId}:refund`);
    expect(rows[0]!.jobId).toBe(`prompt_studio-refund-${held.jobId}`);

    await replayMany('refund', payload);
    expect(await creditService.balanceFor(held.userId)).toEqual({
      available: STARTING_BALANCE,
      pending: 0,
    });
    const ledger = await ledgerFor(held.userId, held.jobId);
    expect(ledger.filter((row) => row.account === 'refund')).toHaveLength(1);
    expect(ledger.filter((row) => row.account === 'spend')).toHaveLength(0);
  });

  it('a fresh leased claim with a real hold is not reaped or refunded', async () => {
    const held = await seedHeldClaim({ stale: false, op: 'assist' });
    expect(await sweepExpiredScriptRequests(log, 10 * 60_000)).toBe(0);
    const [claim] = await db
      .select()
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.id, held.claimId));
    expect(claim?.status).toBe('in_progress');
    expect(await outboxFor(held.jobId)).toHaveLength(0);
    expect(await creditService.balanceFor(held.userId)).toEqual({
      available: STARTING_BALANCE - COST,
      pending: COST,
    });

    // Settle test data explicitly, proving the untouched hold is still recoverable.
    await creditService.refund({
      userId: held.userId,
      jobId: held.jobId,
      amount: COST,
      reason: 'test.cleanup',
      idempotencyKey: paidScriptClaimKey(held.op, held.jobId, 'refund'),
    });
    expect(await creditService.balanceFor(held.userId)).toEqual({
      available: STARTING_BALANCE,
      pending: 0,
    });
  });
});
