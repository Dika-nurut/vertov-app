import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  creditBucketAllocations,
  creditBuckets,
  creditTransactions,
  db,
  nid,
  usersApp,
} from '@seed/db';

const AVAILABLE_ACCOUNTS = [
  'subscription_grant',
  'pack_grant',
  'bonus_grant',
  'refund',
  'available',
] as const;

const ABSORBED_GRANT_LEG = or(
  inArray(creditTransactions.account, ['subscription_grant', 'pack_grant', 'bonus_grant']),
  and(eq(creditTransactions.account, 'refund'), isNull(creditTransactions.relatedJobId)),
);

export interface BucketBackfillReport {
  usersSeen: number;
  usersBackfilled: number;
  allocationsCreated: number;
}

export const BUCKET_BACKFILL_WRITERS_STOPPED_MESSAGE =
  'Refusing credit bucket backfill: stop API and worker writers, then set BUCKET_BACKFILL_WRITERS_STOPPED=1.';

/**
 * Run only with API and worker writers stopped. This deliberately is not a
 * migration: it snapshots the final pooled ledger into one immortal legacy
 * bucket per user and makes each open reservation settleable by the allocator.
 */
export async function backfillCreditBuckets(
  onlyUserIds?: readonly string[],
): Promise<BucketBackfillReport> {
  if (process.env.BUCKET_BACKFILL_WRITERS_STOPPED !== '1') {
    throw new Error(BUCKET_BACKFILL_WRITERS_STOPPED_MESSAGE);
  }

  const users = await db
    .selectDistinct({ userId: creditTransactions.userId })
    .from(creditTransactions)
    .where(onlyUserIds ? inArray(creditTransactions.userId, onlyUserIds) : undefined);
  let usersBackfilled = 0;
  let allocationsCreated = 0;

  for (const { userId } of users) {
    const result = await db.transaction(async (tx) => {
      await tx
        .select({ id: usersApp.id })
        .from(usersApp)
        .where(eq(usersApp.id, userId))
        .for('update');
      const existing = await tx
        .select({ id: creditBuckets.id })
        .from(creditBuckets)
        .where(eq(creditBuckets.userId, userId))
        .limit(1);
      if (existing.length > 0) return { created: false, allocations: 0 };

      const [balances] = await tx
        .select({
          available: sql<string>`COALESCE(SUM(CASE WHEN ${inArray(creditTransactions.account, [...AVAILABLE_ACCOUNTS])} THEN ${creditTransactions.amount} ELSE 0 END), 0)`,
          pending: sql<string>`COALESCE(SUM(CASE WHEN ${eq(creditTransactions.account, 'pending')} THEN ${creditTransactions.amount} ELSE 0 END), 0)`,
        })
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, userId));
      const available = Number(balances?.available ?? 0);
      const pending = Number(balances?.pending ?? 0);
      const bucketId = nid();
      await tx.insert(creditBuckets).values({
        id: bucketId,
        userId,
        origin: 'legacy',
        priority: 3,
        granted: available + pending,
        reserved: pending,
        consumed: 0,
        expiresAt: null,
        grantKey: `legacy:${userId}`,
      });

      const reservations = await tx
        .select({
          jobId: creditTransactions.relatedJobId,
          amount: sql<string>`SUM(${creditTransactions.amount})`,
        })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, userId),
            eq(creditTransactions.account, 'pending'),
            isNotNull(creditTransactions.relatedJobId),
          ),
        )
        .groupBy(creditTransactions.relatedJobId)
        .having(sql`SUM(${creditTransactions.amount}) > 0`);
      for (const reservation of reservations) {
        await tx.insert(creditBucketAllocations).values({
          id: nid(),
          bucketId,
          userId,
          jobId: reservation.jobId,
          kind: 'reserve',
          amount: Number(reservation.amount),
          idempotencyKey: `legacy:${userId}:reserve:${reservation.jobId}:bucket:${bucketId}`,
        });
      }

      // These — and only these — are ledger grant legs absorbed into the legacy
      // balance. Marking them prevents the reconciler from minting them again.
      await tx
        .update(creditTransactions)
        .set({ bucketId })
        .where(
          and(
            eq(creditTransactions.userId, userId),
            isNull(creditTransactions.bucketId),
            ABSORBED_GRANT_LEG,
          ),
        );
      return { created: true, allocations: reservations.length };
    });
    if (result.created) usersBackfilled++;
    allocationsCreated += result.allocations;
  }
  return { usersSeen: users.length, usersBackfilled, allocationsCreated };
}

/**
 * Verifier for the deploy barrier. Its predicate intentionally matches the
 * design verbatim: ordinary grant accounts without a bucket UNION refund legs
 * without a job (admin compensation), also without a bucket.
 */
export async function reconcileUnbucketedGrantLegs() {
  return db
    .select()
    .from(creditTransactions)
    .where(
      or(
        and(
          inArray(creditTransactions.account, ['subscription_grant', 'pack_grant', 'bonus_grant']),
          isNull(creditTransactions.bucketId),
        ),
        and(
          eq(creditTransactions.account, 'refund'),
          isNull(creditTransactions.bucketId),
          isNull(creditTransactions.relatedJobId),
        ),
      ),
    );
}
