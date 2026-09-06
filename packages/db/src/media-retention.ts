import { and, eq, gt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index';

export const FREE_MEDIA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type MediaRetentionExecutor = Pick<PgDatabase<any, typeof schema>, 'execute' | 'select'>;

/** Serialize every paid-storage decision/write for one user. Acquire before any asset lock. */
export async function lockMediaStorageUser(
  executor: Pick<MediaRetentionExecutor, 'execute'>,
  userId: string,
): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
}

/** The canonical paid-media-storage entitlement, valid for both DBs and transactions. */
export async function hasPaidMediaStorage(
  executor: Pick<MediaRetentionExecutor, 'select'>,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [[user], [subscription], [paidPack]] = await Promise.all([
    executor
      .select({ tier: schema.usersApp.tier })
      .from(schema.usersApp)
      .where(eq(schema.usersApp.id, userId))
      .limit(1),
    executor
      .select({ id: schema.subscriptions.id })
      .from(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.userId, userId),
          eq(schema.subscriptions.status, 'active'),
          gt(schema.subscriptions.currentPeriodEnd, now),
        ),
      )
      .limit(1),
    executor
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.userId, userId),
          eq(schema.orders.kind, 'pack'),
          eq(schema.orders.ourStatus, 'paid'),
        ),
      )
      .limit(1),
  ]);
  return Boolean(user && user.tier !== 'free') || Boolean(subscription) || Boolean(paidPack);
}

/** `expires_at` is the only media-retention clock: paid is permanent, free is thirty days. */
export function mediaExpiresAt(isPaid: boolean, now: Date = new Date()): Date | null {
  return isPaid ? null : new Date(now.getTime() + FREE_MEDIA_RETENTION_MS);
}
