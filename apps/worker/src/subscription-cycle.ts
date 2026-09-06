import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { CreditService } from '@seed/credits';
import {
  db,
  galleryItems,
  hasPaidMediaStorage,
  lockMediaStorageUser,
  mediaExpiresAt,
  nid,
  orders,
  subscriptions,
  subscriptionsCatalog,
  usersPii,
} from '@seed/db';
import { createTochkaProvider, type TochkaPaymentProvider } from '@seed/provider-tochka';

/**
 * Daily-ish cycle worker. For every subscription with
 * `currentPeriodEnd <= now()`:
 *   - if `cancelAtPeriodEnd` is true (opt-in renewal off, the default),
 *     flip status to 'expired' and skip the renewal.
 *   - else: create a renewal `orders` row (kind='subscription',
 *     metadata.purpose='renewal'), grant `creditsPerCycle` to the
 *     `subscription_grant` account with idempotency key
 *     `sub:${id}:cycle:${nextCycle}`, advance period by 30 days,
 *     bump `cycleNumber`.
 *
 * Stub-mode adapter: we skip the network call and immediately mark the
 * renewal order paid. Live mode would require a saved-card payment-method
 * id (out of scope for W3 — flagged in the W4 wedge list).
 *
 * Leader election via Redis SET NX PX prevents N worker instances from
 * racing the same renewal.
 */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const LEADER_KEY = 'seed:sub-cycle:leader';
const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CycleOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  /** First tick after this many ms (so tests can fire immediately). */
  firstTickDelayMs?: number;
  /** Test seam; production uses the configured Tochka adapter. */
  tochkaProvider?: Pick<TochkaPaymentProvider, 'chargeSubscription'>;
}

export interface CycleHandle {
  stop(): void;
  tick(): Promise<{ renewed: number; expired: number }>;
}

const credits = new CreditService();

export function startSubscriptionCycle(opts: CycleOptions): CycleHandle {
  const intervalMs =
    opts.intervalMs ?? Number(process.env.SUB_CYCLE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const firstDelay = opts.firstTickDelayMs ?? 5_000;
  const instanceId = randomUUID();
  let stopped = false;

  async function tick(): Promise<{ renewed: number; expired: number }> {
    const lockTtl = Math.max(1_000, Math.floor(intervalMs * 0.8));
    const acquired = await opts.redis.set(LEADER_KEY, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') {
      opts.log.debug({ instanceId }, 'sub-cycle: skipping tick (not leader)');
      return { renewed: 0, expired: 0 };
    }

    const now = new Date();
    const due = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.status, 'active'), lte(subscriptions.currentPeriodEnd, now)));

    let renewed = 0;
    let expired = 0;

    for (const candidate of due) {
      if ((process.env.BILLING_PROVIDER ?? 'yookassa').toLowerCase() === 'tochka') {
        // Match the stub path: an opted-out period must expire without a
        // charge. This check belongs before the provider lookup/order probe;
        // otherwise a live Tochka worker could charge a customer who explicitly
        // cancelled at period end (and a missing psp subscription id would be
        // misclassified as payment failure instead of normal expiry). The
        // locked renewal insert below re-checks the flag too, closing the race
        // where cancellation lands after the initial due-row query.
        if (candidate.cancelAtPeriodEnd) {
          const outcome = await db.transaction(async (tx) => {
            await lockMediaStorageUser(tx, candidate.userId);
            const [sub] = await tx
              .select()
              .from(subscriptions)
              .where(eq(subscriptions.id, candidate.id))
              .limit(1)
              .for('update');
            if (
              !sub ||
              sub.status !== 'active' ||
              sub.currentPeriodEnd > now ||
              !sub.cancelAtPeriodEnd
            ) {
              return 'skipped';
            }
            const transitioned = await tx
              .update(subscriptions)
              .set({ status: 'expired', cancelAtPeriodEnd: true })
              .where(
                and(
                  eq(subscriptions.id, sub.id),
                  eq(subscriptions.status, 'active'),
                  eq(subscriptions.cancelAtPeriodEnd, true),
                  lte(subscriptions.currentPeriodEnd, now),
                ),
              )
              .returning({ id: subscriptions.id });
            if (transitioned.length === 0) return 'skipped';
            if (!(await hasPaidMediaStorage(tx, sub.userId, now))) {
              await tx
                .update(galleryItems)
                .set({ expiresAt: mediaExpiresAt(false, now) })
                .where(
                  and(
                    eq(galleryItems.userId, sub.userId),
                    isNull(galleryItems.expiresAt),
                    isNull(galleryItems.deletedAt),
                  ),
                );
            }
            return 'expired';
          });
          if (outcome === 'expired') expired++;
          continue;
        }
        // A Tochka renewal is a real bank operation. Keep the order pending
        // until the signed acquiringInternetPayment webhook arrives; only
        // that webhook is allowed to grant credits and advance the period.
        const nextCycle = candidate.cycleNumber + 1;
        const existingPending = await db
          .select({ id: orders.id })
          .from(orders)
          .where(
            and(
              eq(orders.userId, candidate.userId),
              eq(orders.kind, 'subscription'),
              eq(orders.psp, 'tochka'),
              eq(orders.ourStatus, 'pending'),
              sql`${orders.metadata}->>'subscriptionId' = ${candidate.id}`,
              sql`${orders.metadata}->>'cycleNumber' = ${String(nextCycle)}`,
            ),
          )
          .limit(1);
        if (existingPending.length > 0) continue;
        if (!candidate.pspSubscriptionId) {
          await db
            .update(subscriptions)
            .set({ status: 'past_due' })
            .where(and(eq(subscriptions.id, candidate.id), eq(subscriptions.status, 'active')));
          opts.log.error(
            { subscriptionId: candidate.id },
            'sub-cycle: Tochka subscription id missing',
          );
          continue;
        }
        const renewalOrderId = nid();
        const contactRows = await db
          .select({ email: usersPii.email, phone: usersPii.phone })
          .from(usersPii)
          .where(eq(usersPii.id, candidate.userId))
          .limit(1);
        const provider = opts.tochkaProvider ?? createTochkaProvider();
        const inserted = await db.transaction(async (tx) => {
          await lockMediaStorageUser(tx, candidate.userId);
          const [sub] = await tx
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.id, candidate.id))
            .limit(1)
            .for('update');
          if (
            !sub ||
            sub.status !== 'active' ||
            sub.currentPeriodEnd > now ||
            sub.cancelAtPeriodEnd ||
            sub.cycleNumber !== candidate.cycleNumber
          )
            return false;
          await tx.insert(orders).values({
            id: renewalOrderId,
            userId: sub.userId,
            kind: 'subscription',
            tierOrPackId: sub.tier,
            amountRub: sub.priceRub,
            psp: 'tochka',
            // Leave the PSP id unbound until Charge Subscription returns. A
            // timeout can still be attributed by paymentLinkId in the signed
            // webhook; a synthetic placeholder would make that real payment
            // look like a different PSP operation and strand the funds.
            pspPaymentId: null,
            pspStatus: 'pending',
            ourStatus: 'pending',
            metadata: {
              purpose: 'renewal',
              subscriptionId: sub.id,
              cycleNumber: nextCycle,
              paymentLinkId: renewalOrderId,
            },
          });
          return true;
        });
        if (!inserted) continue;
        let charged: { paymentId: string; status: string };
        try {
          charged = await provider.chargeSubscription({
            subscriptionId: candidate.pspSubscriptionId,
            amountRub: candidate.priceRub,
            purpose: `Продление подписки ${candidate.tier}`,
            paymentLinkId: renewalOrderId,
            customerEmail: contactRows[0]?.email,
            customerPhone: contactRows[0]?.phone,
            itemTitle: `Продление подписки ${candidate.tier}`,
          });
        } catch (err) {
          // A timeout/transport error is an ambiguous PSP outcome: Tochka may
          // have accepted the charge even though our request never received a
          // response. Keep the local order pending so the signed webhook can
          // bind the real operation and settle it. Lock the same user/order
          // pair as settlement so a late webhook cannot be overwritten by this
          // recovery write after it has already granted the cycle.
          await db.transaction(async (tx) => {
            await lockMediaStorageUser(tx, candidate.userId);
            const [order] = await tx
              .select({ ourStatus: orders.ourStatus })
              .from(orders)
              .where(eq(orders.id, renewalOrderId))
              .limit(1)
              .for('update');
            if (!order || order.ourStatus !== 'pending') return;
            await tx
              .update(orders)
              .set({ pspStatus: 'charge_unknown' })
              .where(and(eq(orders.id, renewalOrderId), eq(orders.ourStatus, 'pending')));
            await tx
              .update(subscriptions)
              .set({ status: 'past_due' })
              .where(and(eq(subscriptions.id, candidate.id), eq(subscriptions.status, 'active')));
          });
          opts.log.error(
            { err, subscriptionId: candidate.id, renewalOrderId },
            'sub-cycle: Tochka charge outcome unknown; renewal order retained pending',
          );
          continue;
        }
        await db
          .update(orders)
          .set({ pspPaymentId: charged.paymentId, pspStatus: charged.status })
          .where(and(eq(orders.id, renewalOrderId), eq(orders.ourStatus, 'pending')));
        continue;
      }
      const outcome = await db.transaction(async (tx) => {
        await lockMediaStorageUser(tx, candidate.userId);
        const [sub] = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.id, candidate.id))
          .limit(1);
        if (!sub || sub.status !== 'active' || sub.currentPeriodEnd > now) return 'skipped';

        if (sub.cancelAtPeriodEnd) {
          const transitioned = await tx
            .update(subscriptions)
            .set({ status: 'expired' })
            .where(
              and(
                eq(subscriptions.id, sub.id),
                eq(subscriptions.status, 'active'),
                eq(subscriptions.cancelAtPeriodEnd, true),
                lte(subscriptions.currentPeriodEnd, now),
              ),
            )
            .returning({ id: subscriptions.id });
          if (transitioned.length === 0) return 'skipped';
          if (!(await hasPaidMediaStorage(tx, sub.userId, now))) {
            await tx
              .update(galleryItems)
              .set({ expiresAt: mediaExpiresAt(false, now) })
              .where(
                and(
                  eq(galleryItems.userId, sub.userId),
                  isNull(galleryItems.expiresAt),
                  isNull(galleryItems.deletedAt),
                ),
              );
          }
          return 'expired';
        }

        // Apply a scheduled downgrade at the boundary, using the post-lock row.
        let effTier = sub.tier;
        let effPrice = sub.priceRub;
        let effCredits = sub.creditsPerCycle;
        if (sub.pendingTier && sub.pendingTier !== sub.tier) {
          const [cat] = await tx
            .select()
            .from(subscriptionsCatalog)
            .where(eq(subscriptionsCatalog.tier, sub.pendingTier))
            .limit(1);
          if (cat) {
            effTier = sub.pendingTier;
            effPrice = cat.priceRub;
            effCredits = cat.creditsPerCycle;
          }
        }

        const nextCycle = sub.cycleNumber + 1;
        const orderId = nid();
        const pspPaymentId = `cycle-${sub.id}-${nextCycle}`;
        const newPeriodStart = sub.currentPeriodEnd;
        const newPeriodEnd = new Date(sub.currentPeriodEnd.getTime() + CYCLE_MS);
        const transitioned = await tx
          .update(subscriptions)
          .set({
            tier: effTier,
            priceRub: effPrice,
            creditsPerCycle: effCredits,
            pendingTier: null,
            cycleNumber: nextCycle,
            currentPeriodStart: newPeriodStart,
            currentPeriodEnd: newPeriodEnd,
          })
          .where(
            and(
              eq(subscriptions.id, sub.id),
              eq(subscriptions.status, 'active'),
              eq(subscriptions.cancelAtPeriodEnd, false),
              lte(subscriptions.currentPeriodEnd, now),
            ),
          )
          .returning({ id: subscriptions.id });
        if (transitioned.length === 0) return 'skipped';
        await tx.insert(orders).values({
          id: orderId,
          userId: sub.userId,
          kind: 'subscription',
          tierOrPackId: effTier,
          amountRub: effPrice,
          psp: 'yookassa-stub',
          pspPaymentId,
          pspStatus: 'succeeded',
          ourStatus: 'paid',
          paidAt: now,
          metadata: {
            purpose: 'renewal',
            subscriptionId: sub.id,
            cycleNumber: nextCycle,
          },
        });
        await credits.grant({
          userId: sub.userId,
          amount: effCredits,
          account: 'subscription_grant',
          origin: 'subscription',
          expiresAt: newPeriodEnd,
          reason: 'subscription.cycle.renewal',
          sourceOrderId: orderId,
          sourceSubscriptionId: sub.id,
          cycleNumber: nextCycle,
          idempotencyKey: `sub:${sub.id}:cycle:${nextCycle}`,
          tx,
        });
        return 'renewed';
      });
      if (outcome === 'expired') expired++;
      if (outcome === 'renewed') renewed++;
    }

    if (renewed > 0 || expired > 0) {
      opts.log.info({ renewed, expired, instanceId }, 'sub-cycle: tick complete');
    }
    return { renewed, expired };
  }

  async function loop(): Promise<void> {
    await new Promise((r) => setTimeout(r, firstDelay));
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        opts.log.error({ err }, 'sub-cycle: tick failed');
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, instanceId }, 'sub-cycle started');
  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
