import 'dotenv/config';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  creditBucketAllocations,
  creditBuckets,
  creditTransactions,
  db,
  nid,
  pool,
  usersApp,
  usersPii,
} from '@seed/db';
import {
  CreditService,
  IdempotencyKeyConflictError,
  InsufficientCreditsError,
  UnreservedSpendError,
} from '../src/index';

const svc = new CreditService();

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'CreditTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `credits+${id}@seed.local` });
  return id;
}

const createdUsers: string[] = [];

beforeEach(() => {
  createdUsers.length = 0;
});

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(usersApp).where(eq(usersApp.id, id)); // cascades to pii + credit_tx
  }
});

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const id = await makeUser();
  createdUsers.push(id);
  return id;
}

describe('CreditService', () => {
  it('fresh user has 0/0 balance', async () => {
    const u = await newUser();
    expect(await svc.balanceFor(u)).toEqual({ available: 0, pending: 0 });
  });

  it('grant increases available', async () => {
    const u = await newUser();
    const row = await svc.grant({
      userId: u,
      amount: 100,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    expect(row.amount).toBe(100);
    expect(await svc.balanceFor(u)).toEqual({ available: 100, pending: 0 });
  });

  it('reserve moves credits from available into pending', async () => {
    const u = await newUser();
    await svc.grant({
      userId: u,
      amount: 100,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    await svc.reserve({
      userId: u,
      jobId: 'job-1',
      amount: 30,
      reason: 'job.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    expect(await svc.balanceFor(u)).toEqual({ available: 70, pending: 30 });
  });

  it('commit zeroes pending and writes spend', async () => {
    const u = await newUser();
    await svc.grant({
      userId: u,
      amount: 100,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    await svc.reserve({
      userId: u,
      jobId: 'job-1',
      amount: 30,
      reason: 'job.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    await svc.commit({
      userId: u,
      jobId: 'job-1',
      amount: 30,
      idempotencyKey: `commit:${nid()}`,
    });
    expect(await svc.balanceFor(u)).toEqual({ available: 70, pending: 0 });
    const spendRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, u));
    const spend = spendRows.filter((r) => r.account === 'spend');
    expect(spend).toHaveLength(1);
    expect(spend[0]!.amount).toBe(30);
  });

  it('refund returns pending credits back to available', async () => {
    const u = await newUser();
    await svc.grant({
      userId: u,
      amount: 100,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    await svc.reserve({
      userId: u,
      jobId: 'job-2',
      amount: 40,
      reason: 'job.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    await svc.refund({
      userId: u,
      jobId: 'job-2',
      amount: 40,
      reason: 'provider.error',
      idempotencyKey: `refund:${nid()}`,
    });
    expect(await svc.balanceFor(u)).toEqual({ available: 100, pending: 0 });
  });

  // SF-10: commit/refund must not settle more than the job's reservation.
  it('commit/refund refuse to settle more than the outstanding reservation', async () => {
    const u = await newUser();
    await svc.grant({
      userId: u,
      amount: 100,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    await svc.reserve({
      userId: u,
      jobId: 'job-sf10',
      amount: 30,
      reason: 'job.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    // Commit MORE than reserved → refused, ledger untouched.
    await expect(
      svc.commit({ userId: u, jobId: 'job-sf10', amount: 31, idempotencyKey: `commit:${nid()}` }),
    ).rejects.toBeInstanceOf(UnreservedSpendError);
    // Refund against a job with NO reservation → refused.
    await expect(
      svc.refund({
        userId: u,
        jobId: 'job-never-reserved',
        amount: 1,
        reason: 'x',
        idempotencyKey: `refund:${nid()}`,
      }),
    ).rejects.toBeInstanceOf(UnreservedSpendError);
    // The valid commit (≤ reserved) still works.
    await svc.commit({
      userId: u,
      jobId: 'job-sf10',
      amount: 30,
      idempotencyKey: `commit:${nid()}`,
    });
    expect(await svc.balanceFor(u)).toEqual({ available: 70, pending: 0 });
  });

  it('grant is replay-safe on idempotencyKey', async () => {
    const u = await newUser();
    const key = `grant:${nid()}`;
    const first = await svc.grant({
      userId: u,
      amount: 50,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: key,
    });
    const second = await svc.grant({
      userId: u,
      amount: 50,
      reason: 'signup_bonus retry wording',
      account: 'subscription_grant',
      idempotencyKey: key,
    });
    expect(second.id).toBe(first.id);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    const rows = await db.select().from(creditTransactions).where(eq(creditTransactions.userId, u));
    expect(rows).toHaveLength(1);
    const buckets = await db.select().from(creditBuckets).where(eq(creditBuckets.userId, u));
    expect(buckets).toHaveLength(1);
    expect(await svc.balanceFor(u)).toEqual({ available: 50, pending: 0 });
  });

  it('rejects a grant key reused for a different user', async () => {
    const firstUser = await newUser();
    const secondUser = await newUser();
    const key = `grant:${nid()}`;
    await svc.grant({
      userId: firstUser,
      amount: 50,
      reason: 'support.grant',
      account: 'pack_grant',
      idempotencyKey: key,
    });

    await expect(
      svc.grant({
        userId: secondUser,
        amount: 50,
        reason: 'support.grant',
        account: 'pack_grant',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await svc.balanceFor(secondUser)).toEqual({ available: 0, pending: 0 });
  });

  it('rejects a grant key reused for a different amount', async () => {
    const u = await newUser();
    const key = `grant:${nid()}`;
    await svc.grant({
      userId: u,
      amount: 50,
      reason: 'support.grant',
      account: 'pack_grant',
      idempotencyKey: key,
    });

    await expect(
      svc.grant({
        userId: u,
        amount: 51,
        reason: 'support.grant',
        account: 'pack_grant',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await svc.balanceFor(u)).toEqual({ available: 50, pending: 0 });
  });

  it('rejects a grant key reused for a different account', async () => {
    const u = await newUser();
    const key = `grant:${nid()}`;
    await svc.grant({
      userId: u,
      amount: 50,
      reason: 'support.grant',
      account: 'pack_grant',
      idempotencyKey: key,
    });

    await expect(
      svc.grant({
        userId: u,
        amount: 50,
        reason: 'support.grant',
        account: 'refund',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await svc.balanceFor(u)).toEqual({ available: 50, pending: 0 });
  });

  it('reserve throws InsufficientCreditsError when balance is too low', async () => {
    const u = await newUser();
    await svc.grant({
      userId: u,
      amount: 10,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    await expect(
      svc.reserve({
        userId: u,
        jobId: 'job-3',
        amount: 50,
        reason: 'job.reserve',
        idempotencyKey: `reserve:${nid()}`,
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await svc.balanceFor(u)).toEqual({ available: 10, pending: 0 });
  });

  it('concurrent reserves with insufficient balance: exactly one succeeds', async () => {
    const u = await newUser();
    await svc.grant({
      userId: u,
      amount: 30,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        svc.reserve({
          userId: u,
          jobId: `job-c-${i}`,
          amount: 20,
          reason: 'job.reserve',
          idempotencyKey: `reserve:${nid()}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(4);
    for (const r of fail) {
      expect(r.reason).toBeInstanceOf(InsufficientCreditsError);
    }
    expect(await svc.balanceFor(u)).toEqual({ available: 10, pending: 20 });
  });

  it('concurrent retries with one reserve key mutate exactly one allocation set', async () => {
    const u = await newUser();
    await svc.grant({
      userId: u,
      amount: 50,
      reason: 'first',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    await svc.grant({
      userId: u,
      amount: 50,
      reason: 'second',
      account: 'pack_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    const key = `reserve-replay:${nid()}`;
    await Promise.all([
      svc.reserve({
        userId: u,
        jobId: 'replay-job',
        amount: 50,
        reason: 'test.reserve',
        idempotencyKey: key,
      }),
      svc.reserve({
        userId: u,
        jobId: 'replay-job',
        amount: 50,
        reason: 'test.reserve',
        idempotencyKey: key,
      }),
    ]);

    const allocations = await db
      .select()
      .from(creditBucketAllocations)
      .where(sql`${creditBucketAllocations.idempotencyKey} LIKE ${`${key}:bucket:%`}`);
    expect(allocations).toHaveLength(1);
    const [ledger] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${creditTransactions.amount}) FILTER (WHERE ${creditTransactions.account} IN ('subscription_grant', 'pack_grant', 'bonus_grant', 'refund', 'available')), 0)`,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, u));
    const [buckets] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${creditBuckets.granted} - ${creditBuckets.reserved} - ${creditBuckets.consumed}), 0)`,
      })
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, u));
    expect(Number(ledger?.total)).toBe(Number(buckets?.total));
  });

  it('does not reserve a later grant beyond the net live balance after clawback debt', async () => {
    const u = await newUser();
    const orderId = `order:${nid()}`;
    await svc.grant({
      userId: u,
      amount: 50,
      reason: 'purchased',
      account: 'pack_grant',
      sourceOrderId: orderId,
      idempotencyKey: `grant:${nid()}`,
    });
    await svc.clawback({
      userId: u,
      amount: 100,
      reason: 'payment.refund.clawback',
      sourceOrderId: orderId,
      idempotencyKey: `clawback:${nid()}`,
    });
    await svc.grant({
      userId: u,
      amount: 100,
      reason: 'later grant',
      account: 'pack_grant',
      idempotencyKey: `grant:${nid()}`,
    });

    expect(await svc.balanceFor(u)).toEqual({ available: 50, pending: 0 });
    await expect(
      svc.reserve({
        userId: u,
        jobId: 'debt-job',
        amount: 60,
        reason: 'test.reserve',
        idempotencyKey: `reserve:${nid()}`,
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('transactionsFor paginates newest-first with a composite cursor', async () => {
    const u = await newUser();
    const insertedAt: Date[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await svc.grant({
        userId: u,
        amount: 10,
        reason: `seed_${i}`,
        account: 'pack_grant',
        idempotencyKey: `grant:${nid()}`,
      });
      insertedAt.push(row.createdAt);
      // Force distinct millisecond timestamps so newest-first ordering is
      // deterministic regardless of nid() lexical order.
      await new Promise((r) => setTimeout(r, 5));
    }
    const page1 = await svc.transactionsFor(u, { limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).toMatch(/^\d{4}-\d{2}-\d{2}T.+\|.+/);
    // Newest-first: page1 row 0 is the latest insert (i=4).
    expect(page1.rows[0]!.reason).toBe('seed_4');
    expect(page1.rows[1]!.reason).toBe('seed_3');

    const page2 = await svc.transactionsFor(u, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.rows).toHaveLength(2);
    expect(page2.rows[0]!.reason).toBe('seed_2');
    expect(page2.rows[1]!.reason).toBe('seed_1');

    const page3 = await svc.transactionsFor(u, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.rows).toHaveLength(1);
    expect(page3.rows[0]!.reason).toBe('seed_0');
    expect(page3.nextCursor).toBeNull();
  });

  // --- Reservation-coverage enforcement (W1.Fri) ------------------------------

  async function fundAndReserve(amount: number, jobId: string): Promise<string> {
    const u = await newUser();
    await svc.grant({
      userId: u,
      amount: 1000,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    await svc.reserve({
      userId: u,
      jobId,
      amount,
      reason: 'job.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    return u;
  }

  it('commit larger than the reservation is rejected and leaves the ledger untouched', async () => {
    const u = await fundAndReserve(30, 'job-oc');
    await expect(
      svc.commit({ userId: u, jobId: 'job-oc', amount: 40, idempotencyKey: `commit:${nid()}` }),
    ).rejects.toBeInstanceOf(UnreservedSpendError);
    // Pending reservation and available pool are exactly as the reserve left them.
    expect(await svc.balanceFor(u)).toEqual({ available: 970, pending: 30 });
    const rows = await db.select().from(creditTransactions).where(eq(creditTransactions.userId, u));
    expect(rows.some((r) => r.account === 'spend')).toBe(false);
  });

  it('refund larger than the reservation is rejected and leaves the ledger untouched', async () => {
    const u = await fundAndReserve(40, 'job-or');
    await expect(
      svc.refund({
        userId: u,
        jobId: 'job-or',
        amount: 50,
        reason: 'provider.error',
        idempotencyKey: `refund:${nid()}`,
      }),
    ).rejects.toBeInstanceOf(UnreservedSpendError);
    expect(await svc.balanceFor(u)).toEqual({ available: 960, pending: 40 });
    const rows = await db.select().from(creditTransactions).where(eq(creditTransactions.userId, u));
    expect(rows.some((r) => r.account === 'refund')).toBe(false);
  });

  it('duplicate commit (same key) is idempotent — books spend exactly once', async () => {
    const u = await fundAndReserve(30, 'job-dc');
    const key = `commit:${nid()}`;
    const first = await svc.commit({
      userId: u,
      jobId: 'job-dc',
      amount: 30,
      idempotencyKey: key,
    });
    const second = await svc.commit({
      userId: u,
      jobId: 'job-dc',
      amount: 30,
      idempotencyKey: key,
    });
    expect(second.spend.id).toBe(first.spend.id);
    expect(await svc.balanceFor(u)).toEqual({ available: 970, pending: 0 });
    const spend = (
      await db.select().from(creditTransactions).where(eq(creditTransactions.userId, u))
    ).filter((r) => r.account === 'spend');
    expect(spend).toHaveLength(1);
    expect(spend[0]!.amount).toBe(30);
  });

  it('rejects reusing a settlement key for a different amount or job', async () => {
    const u = await fundAndReserve(30, 'job-idem');
    const key = `commit:${nid()}`;
    await svc.commit({ userId: u, jobId: 'job-idem', amount: 30, idempotencyKey: key });

    await expect(
      svc.commit({ userId: u, jobId: 'job-idem', amount: 29, idempotencyKey: key }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(
      svc.commit({ userId: u, jobId: 'different-job', amount: 30, idempotencyKey: key }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    expect(await svc.balanceFor(u)).toEqual({ available: 970, pending: 0 });
  });

  it('rejects reusing a reserve key for a different user or amount', async () => {
    const firstUser = await newUser();
    const secondUser = await newUser();
    await svc.grant({
      userId: firstUser,
      amount: 100,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    await svc.grant({
      userId: secondUser,
      amount: 100,
      reason: 'signup_bonus',
      account: 'subscription_grant',
      idempotencyKey: `grant:${nid()}`,
    });
    const key = `reserve:${nid()}`;
    await svc.reserve({
      userId: firstUser,
      jobId: 'job-idem-reserve',
      amount: 20,
      reason: 'job.reserve',
      idempotencyKey: key,
    });

    await expect(
      svc.reserve({
        userId: firstUser,
        jobId: 'job-idem-reserve',
        amount: 21,
        reason: 'job.reserve',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(
      svc.reserve({
        userId: secondUser,
        jobId: 'job-idem-reserve',
        amount: 20,
        reason: 'job.reserve',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it('rejects reusing a refund key for a different amount or job', async () => {
    const u = await fundAndReserve(20, 'job-idem-refund');
    const key = `refund:${nid()}`;
    await svc.refund({
      userId: u,
      jobId: 'job-idem-refund',
      amount: 20,
      reason: 'provider.error',
      idempotencyKey: key,
    });

    await expect(
      svc.refund({
        userId: u,
        jobId: 'job-idem-refund',
        amount: 19,
        reason: 'provider.error',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(
      svc.refund({
        userId: u,
        jobId: 'different-job',
        amount: 20,
        reason: 'provider.error',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await svc.balanceFor(u)).toEqual({ available: 1000, pending: 0 });
  });

  it('partial refund after partial spend nets to zero pending; over-refund of the remainder fails', async () => {
    const u = await fundAndReserve(40, 'job-ps');
    // Worker success path: commit the spent portion, refund the unused remainder.
    await svc.commit({ userId: u, jobId: 'job-ps', amount: 30, idempotencyKey: `commit:${nid()}` });
    await svc.refund({
      userId: u,
      jobId: 'job-ps',
      amount: 10,
      reason: 'partial.unused',
      idempotencyKey: `refund-partial:${nid()}`,
    });
    // 1000 − 40 reserved + 10 refunded = 970 available; pending fully resolved.
    expect(await svc.balanceFor(u)).toEqual({ available: 970, pending: 0 });
    // Nothing left outstanding: a further refund must be rejected.
    await expect(
      svc.refund({
        userId: u,
        jobId: 'job-ps',
        amount: 1,
        reason: 'provider.error',
        idempotencyKey: `refund-extra:${nid()}`,
      }),
    ).rejects.toBeInstanceOf(UnreservedSpendError);
  });

  it('commit + refund legs are order-independent and both pass coverage', async () => {
    const u = await fundAndReserve(40, 'job-ord');
    // Refund the unused remainder BEFORE committing the spent portion.
    await svc.refund({
      userId: u,
      jobId: 'job-ord',
      amount: 10,
      reason: 'partial.unused',
      idempotencyKey: `refund-partial:${nid()}`,
    });
    await svc.commit({
      userId: u,
      jobId: 'job-ord',
      amount: 30,
      idempotencyKey: `commit:${nid()}`,
    });
    expect(await svc.balanceFor(u)).toEqual({ available: 970, pending: 0 });
  });
});
