import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index';

/**
 * PLAN ACCESS — the single answer to canon Q1, "which models may I run".
 *
 * Before W0 there were two answers and neither was right: the job gate read
 * `users_app.tier`, a column no payment path writes, and the model pickers read
 * `findActiveSubscription`, which filtered on status but never on the period, so
 * a newer ELAPSED row shadowed an older LIVE one.
 *
 * This module is the one predicate. Keep it separate from the LIFECYCLE selector
 * in `apps/api/src/subscriptions.ts` (`findLifecycleSubscription`), which
 * deliberately ignores the period: a subscription whose month has run out is
 * still the row the management card cancels and the pricing CTAs act on. The two
 * questions are different, so the two queries are different.
 */

/** The statuses that still carry entitlement. `past_due` is included on purpose:
 *  a declined charge does not retroactively unsell the month already paid for —
 *  the period check below is what ends access. */
export const PLAN_ACCESS_STATUSES = ['active', 'trialing', 'past_due'] as const;

/** Valid for a `db` handle and for a transaction alike — the same structural
 *  type `media-retention.ts` already uses, which both satisfy. */
type PlanAccessExecutor = Pick<PgDatabase<any, typeof schema>, 'select'>;

export type PlanSubscription = typeof schema.subscriptions.$inferSelect;
export type PlanTier = PlanSubscription['tier'];

/**
 * The subscription row that entitles this user right now, or null.
 *
 * Predicate: status ∈ PLAN_ACCESS_STATUSES **and** the paid period has not
 * elapsed. Among rows that qualify, the newest by `createdAt`.
 *
 * The ordering rule matters and is deliberately conservative. Several
 * concurrently-live rows can only come from the unresolved duplicate-subscribe
 * flow, where retiring the loser has to happen at settlement under the per-user
 * lock. Picking, say, the highest tier here would quietly set duplicate-payment
 * entitlement policy, which is W1's call to make — so W0 changes exactly one
 * thing: an elapsed row can no longer shadow a live one.
 */
export async function resolveLivePlanSubscription(
  executor: PlanAccessExecutor,
  userId: string,
  now: Date = new Date(),
): Promise<PlanSubscription | null> {
  const [row] = await executor
    .select()
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.userId, userId),
        inArray(schema.subscriptions.status, [...PLAN_ACCESS_STATUSES]),
        gt(schema.subscriptions.currentPeriodEnd, now),
      ),
    )
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1);
  return row ?? null;
}

/** The tier every entitlement check gates on. No live plan ⇒ `free`, whatever
 *  `users_app.tier` happens to say. */
export async function resolveUserPlanTier(
  executor: PlanAccessExecutor,
  userId: string,
  now: Date = new Date(),
): Promise<PlanTier> {
  const live = await resolveLivePlanSubscription(executor, userId, now);
  return live?.tier ?? 'free';
}
