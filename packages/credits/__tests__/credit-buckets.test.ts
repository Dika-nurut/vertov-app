import 'dotenv/config';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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
import { CreditService, WelcomeGrantService, backfillCreditBuckets, grantKey } from '../src/index';

const credits = new CreditService();
const welcome = new WelcomeGrantService({ credits });
const createdUsers: string[] = [];

beforeEach(() => {
  createdUsers.length = 0;
});

afterEach(async () => {
  for (const id of createdUsers) await db.delete(usersApp).where(eq(usersApp.id, id));
});

afterAll(async () => {
  await pool.end();
});

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'BucketTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `buckets+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

async function grant(input: {
  userId: string;
  amount: number;
  origin: 'welcome' | 'subscription' | 'pack' | 'bonus';
  expiresAt: Date | null;
  key?: string;
  sourceOrderId?: string;
}) {
  const account =
    input.origin === 'subscription'
      ? 'subscription_grant'
      : input.origin === 'pack'
        ? 'pack_grant'
        : 'bonus_grant';
  return credits.grant({
    userId: input.userId,
    amount: input.amount,
    account,
    origin: input.origin,
    expiresAt: input.expiresAt,
    ...(input.sourceOrderId ? { sourceOrderId: input.sourceOrderId } : {}),
    reason: `test.${input.origin}`,
    idempotencyKey: input.key ?? `grant:${nid()}`,
  });
}

async function runBackfill(onlyUserIds: readonly string[]) {
  const previous = process.env.BUCKET_BACKFILL_WRITERS_STOPPED;
  process.env.BUCKET_BACKFILL_WRITERS_STOPPED = '1';
  try {
    return await backfillCreditBuckets(onlyUserIds);
  } finally {
    if (previous === undefined) delete process.env.BUCKET_BACKFILL_WRITERS_STOPPED;
    else process.env.BUCKET_BACKFILL_WRITERS_STOPPED = previous;
  }
}

describe('credit buckets', () => {
  it('spends welcome before an earlier-expiring subscription, and packs last', async () => {
    const userId = await makeUser();
    await grant({
      userId,
      amount: 10,
      origin: 'welcome',
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    await grant({
      userId,
      amount: 10,
      origin: 'subscription',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await grant({ userId, amount: 10, origin: 'pack', expiresAt: null });

    await credits.reserve({
      userId,
      jobId: 'spend-order',
      amount: 25,
      reason: 'test.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    const allocations = await db
      .select({ origin: creditBuckets.origin, amount: creditBucketAllocations.amount })
      .from(creditBucketAllocations)
      .innerJoin(creditBuckets, eq(creditBucketAllocations.bucketId, creditBuckets.id))
      .where(eq(creditBucketAllocations.jobId, 'spend-order'))
      .orderBy(creditBuckets.priority);
    expect(allocations).toEqual([
      { origin: 'welcome', amount: 10 },
      { origin: 'subscription', amount: 10 },
      { origin: 'pack', amount: 5 },
    ]);
  });

  it('does not spend expired credit, but settles its existing reservation', async () => {
    const userId = await makeUser();
    await grant({
      userId,
      amount: 10,
      origin: 'subscription',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await credits.reserve({
      userId,
      jobId: 'expired-settle',
      amount: 10,
      reason: 'test.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    await db
      .update(creditBuckets)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(creditBuckets.userId, userId));
    expect(await credits.balanceFor(userId)).toEqual({ available: 0, pending: 10 });
    await credits.commit({
      userId,
      jobId: 'expired-settle',
      amount: 10,
      idempotencyKey: `commit:${nid()}`,
    });
    expect(await credits.balanceFor(userId)).toEqual({ available: 0, pending: 0 });
  });

  it('refunds to the original bucket even after that bucket expires', async () => {
    const userId = await makeUser();
    await grant({
      userId,
      amount: 10,
      origin: 'subscription',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await credits.reserve({
      userId,
      jobId: 'expired-refund',
      amount: 10,
      reason: 'test.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    await db
      .update(creditBuckets)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(creditBuckets.userId, userId));
    await credits.refund({
      userId,
      jobId: 'expired-refund',
      amount: 10,
      reason: 'test.refund',
      idempotencyKey: `refund:${nid()}`,
    });
    const [bucket] = await db.select().from(creditBuckets).where(eq(creditBuckets.userId, userId));
    expect(bucket).toMatchObject({ origin: 'subscription', reserved: 0, consumed: 0 });
    expect(await credits.balanceFor(userId)).toEqual({ available: 0, pending: 0 });
  });

  it('keeps the ledger and all buckets equal through reserve, commit, refund, and clawback', async () => {
    const userId = await makeUser();
    await grant({
      userId,
      amount: 100,
      origin: 'subscription',
      expiresAt: new Date(Date.now() + 60_000),
      sourceOrderId: 'order-subscription',
    });
    await grant({
      userId,
      amount: 100,
      origin: 'pack',
      expiresAt: null,
      sourceOrderId: 'order-pack',
    });
    await credits.reserve({
      userId,
      jobId: 'full-sequence',
      amount: 60,
      reason: 'test.reserve',
      idempotencyKey: `reserve:${nid()}`,
    });
    await credits.commit({
      userId,
      jobId: 'full-sequence',
      amount: 30,
      idempotencyKey: `commit:${nid()}`,
    });
    await credits.refund({
      userId,
      jobId: 'full-sequence',
      amount: 30,
      reason: 'test.refund',
      idempotencyKey: `refund:${nid()}`,
    });
    await credits.clawback({
      userId,
      amount: 150,
      reason: 'test.clawback',
      sourceOrderId: 'order-subscription',
      idempotencyKey: `clawback:${nid()}`,
    });
    const [ledger] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${creditTransactions.amount}) FILTER (WHERE ${creditTransactions.account} IN ('subscription_grant', 'pack_grant', 'bonus_grant', 'refund', 'available')), 0)`,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId));
    const [buckets] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${creditBuckets.granted} - ${creditBuckets.reserved} - ${creditBuckets.consumed}), 0)`,
      })
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, userId));
    expect(Number(ledger?.total)).toBe(Number(buckets?.total));
  });

  it('creates one bucket for a retried grant and no unreferenced bucket', async () => {
    const userId = await makeUser();
    const key = `grant:${nid()}`;
    await grant({ userId, amount: 50, origin: 'pack', expiresAt: null, key });
    await grant({ userId, amount: 50, origin: 'pack', expiresAt: null, key });
    const buckets = await db.select().from(creditBuckets).where(eq(creditBuckets.userId, userId));
    const legs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.grantKey).toBe(key);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.bucketId).toBe(buckets[0]!.id);
  });

  it('keeps the ledger and buckets equal after L0 expiry', async () => {
    const userId = await makeUser();
    await grant({
      userId,
      amount: 210,
      origin: 'welcome',
      expiresAt: null,
      key: grantKey(userId, 'L0'),
    });
    await db.transaction((tx) => welcome.expireL0ForUser(userId, tx));

    const [ledger] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${creditTransactions.amount}) FILTER (WHERE ${creditTransactions.account} IN ('subscription_grant', 'pack_grant', 'bonus_grant', 'refund', 'available')), 0)`,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId));
    const [buckets] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${creditBuckets.granted} - ${creditBuckets.reserved} - ${creditBuckets.consumed}), 0)`,
      })
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, userId));
    expect(Number(ledger?.total)).toBe(Number(buckets?.total));
  });

  it('backfills available and open pending once, including a negative available balance', async () => {
    const normal = await makeUser();
    const negative = await makeUser();
    await db.insert(creditTransactions).values([
      {
        id: nid(),
        userId: normal,
        amount: 100,
        account: 'bonus_grant',
        reason: 'legacy.grant',
        idempotencyKey: `legacy-grant:${normal}`,
      },
      {
        id: nid(),
        userId: normal,
        amount: -25,
        account: 'available',
        reason: 'legacy.reserve',
        relatedJobId: 'legacy-job',
        idempotencyKey: `legacy-available:${normal}`,
      },
      {
        id: nid(),
        userId: normal,
        amount: 25,
        account: 'pending',
        reason: 'legacy.reserve',
        relatedJobId: 'legacy-job',
        idempotencyKey: `legacy-pending:${normal}`,
      },
      {
        id: nid(),
        userId: negative,
        amount: 50,
        account: 'bonus_grant',
        reason: 'legacy.grant',
        idempotencyKey: `legacy-grant:${negative}`,
      },
      {
        id: nid(),
        userId: negative,
        amount: -100,
        account: 'available',
        reason: 'legacy.reserve',
        relatedJobId: 'negative-job',
        idempotencyKey: `legacy-available:${negative}`,
      },
      {
        id: nid(),
        userId: negative,
        amount: 100,
        account: 'pending',
        reason: 'legacy.reserve',
        relatedJobId: 'negative-job',
        idempotencyKey: `legacy-pending:${negative}`,
      },
    ]);
    expect(await runBackfill([normal, negative])).toMatchObject({ usersBackfilled: 2 });
    expect(await runBackfill([normal, negative])).toMatchObject({ usersBackfilled: 0 });
    const rows = await db
      .select()
      .from(creditBuckets)
      .where(
        and(
          eq(creditBuckets.origin, 'legacy'),
          sql`${creditBuckets.userId} IN (${normal}, ${negative})`,
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.userId === normal)).toMatchObject({ granted: 100, reserved: 25 });
    expect(rows.find((row) => row.userId === negative)).toMatchObject({
      granted: 50,
      reserved: 100,
    });
    const allocations = await db
      .select()
      .from(creditBucketAllocations)
      .where(sql`${creditBucketAllocations.userId} IN (${normal}, ${negative})`);
    expect(allocations).toHaveLength(2);
  });

  it('does not create a legacy bucket for a user with bucket-native credit on a rerun', async () => {
    const legacyUser = await makeUser();
    await db.insert(creditTransactions).values({
      id: nid(),
      userId: legacyUser,
      amount: 20,
      account: 'bonus_grant',
      reason: 'legacy.grant',
      idempotencyKey: `legacy-grant:${legacyUser}`,
    });
    await runBackfill([legacyUser]);

    const nativeUser = await makeUser();
    await grant({ userId: nativeUser, amount: 50, origin: 'pack', expiresAt: null });
    const before = await credits.balanceFor(nativeUser);
    await runBackfill([legacyUser, nativeUser]);

    expect(await credits.balanceFor(nativeUser)).toEqual(before);
    const legacyBuckets = await db
      .select()
      .from(creditBuckets)
      .where(and(eq(creditBuckets.userId, nativeUser), eq(creditBuckets.origin, 'legacy')));
    expect(legacyBuckets).toHaveLength(0);
  });
});
