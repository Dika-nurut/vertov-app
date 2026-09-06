import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  creditBuckets,
  creditTransactions,
  db,
  galleryItems,
  hasPaidMediaStorage,
  lockMediaStorageUser,
  mediaExpiresAt,
  nid,
  orders,
  resolveLivePlanSubscription,
  schema,
  subscriptions,
  subscriptionsCatalog,
} from '@seed/db';
import { _billingShared, _internal } from './billing';
import {
  acquireBillingIntent,
  attachPspPayment,
  createFailureOutcomeOf,
  releaseBillingIntent,
  SUBSCRIBE_INTENT_KEY,
  upgradeIntentKey,
} from './billing-intent';

const WEB_PUBLIC_URL = process.env.WEB_PUBLIC_URL ?? 'http://127.0.0.1:3000';

interface SessionLike {
  user: { id: string };
}
type SessionResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike | null>;

// Subscribe-able / upgrade-target tiers = the active 5-tier grid. `creator` is a
// legacy tier: existing subs keep it, but no one can newly subscribe/upgrade TO
// it (its catalog row is deactivated, so the isActive check below 400s anyway).
const tierSchema = z.enum(['start', 'plus', 'pro', 'studio', 'max']);

const subscribeSchema = z.object({
  tier: tierSchema,
  customerEmail: z.string().email().optional(),
});
const upgradeSchema = z.object({
  newTier: tierSchema,
  customerEmail: z.string().email().optional(),
});
const downgradeSchema = z.object({ newTier: tierSchema });
// #14 audit: explicit schema so the endpoint rejects non-boolean values
// (e.g. a string "true") at parse time with a structured error response.
const renewToggleSchema = z.object({ autoRenew: z.boolean() });

/** Valid for a `db` handle and for a transaction alike. */
type SubscriptionExecutor = Pick<PgDatabase<any, typeof schema>, 'select'>;
type SubscriptionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The LIFECYCLE selector: the row a billing mutation acts on, or that the
 * management card presents. Newest by `createdAt` among
 * `active|trialing|past_due`, with **no period check** — an elapsed subscription
 * is still the row the customer cancels, and hiding it would strand them.
 *
 * Not an entitlement predicate. "Which models may I run" is
 * `resolveLivePlanSubscription` (@seed/db), which also checks the period.
 *
 * W0 renamed this and parameterised the executor; it changed the semantics of no
 * guard at all. The selector remains deliberately period-blind for management,
 * while paid checkout paths apply the expiry transition below before deciding
 * whether they may create a new intent or price an upgrade.
 */
export async function findLifecycleSubscription(executor: SubscriptionExecutor, userId: string) {
  const rows = await executor
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ['active', 'trialing', 'past_due']),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

type ElapsedSubscriptionAction =
  | { kind: 'missing'; subscriptionId: string }
  | { kind: 'still_live'; subscriptionId: string }
  | { kind: 'retired'; subscriptionId: string }
  | { kind: 'renewal_pending'; subscriptionId: string }
  | { kind: 'payment_pending'; subscriptionId: string; orderId: string }
  | { kind: 'payment_failed'; subscriptionId: string };

/**
 * Resolve an elapsed lifecycle row before a paid checkout acts on it.
 *
 * Management intentionally still sees elapsed rows, but checkout must not turn
 * an expired period into either a 1 ₽ no-access upgrade or a second live plan.
 * The per-user advisory lock is the same lock used by settlement, media
 * retention, and the cycle worker, so the status transition cannot race a
 * renewal or webhook. A pending subscription order is treated as money in
 * flight and is never silently retired underneath it.
 */
async function resolveElapsedSubscription(
  userId: string,
  subscriptionId: string,
  now: Date,
): Promise<ElapsedSubscriptionAction> {
  return db.transaction(async (tx: SubscriptionTransaction) => {
    await lockMediaStorageUser(tx, userId);
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          eq(subscriptions.userId, userId),
          inArray(subscriptions.status, ['active', 'trialing', 'past_due']),
        ),
      )
      .limit(1)
      .for('update');
    if (!sub) return { kind: 'missing', subscriptionId };
    if (sub.currentPeriodEnd > now) return { kind: 'still_live', subscriptionId };

    const [pending] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          eq(orders.kind, 'subscription'),
          eq(orders.ourStatus, 'pending'),
          sql`${orders.metadata}->>'subscriptionId' = ${subscriptionId}`,
        ),
      )
      .limit(1);
    if (pending) {
      return { kind: 'payment_pending', subscriptionId, orderId: pending.id };
    }

    // A past_due row represents a failed renewal, not an opted-out period that
    // may be replaced by a new checkout. Keep it visible for support/retry.
    if (sub.status === 'past_due') return { kind: 'payment_failed', subscriptionId };
    // Auto-renew is an explicit customer choice. The cycle worker may be
    // between its due-row read and settlement, so do not retire this row from
    // an HTTP request while that choice is still enabled.
    if (!sub.cancelAtPeriodEnd) return { kind: 'renewal_pending', subscriptionId };

    const transitioned = await tx
      .update(subscriptions)
      .set({ status: 'expired', cancelAtPeriodEnd: true })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          eq(subscriptions.userId, userId),
          inArray(subscriptions.status, ['active', 'trialing']),
          eq(subscriptions.cancelAtPeriodEnd, true),
          lte(subscriptions.currentPeriodEnd, now),
        ),
      )
      .returning({ id: subscriptions.id });
    if (transitioned.length === 0) {
      // The row was changed after the locked read (for example by a future
      // schema trigger). Failing closed is safer than creating a new plan.
      return { kind: 'still_live', subscriptionId };
    }
    if (!(await hasPaidMediaStorage(tx, userId, now))) {
      await tx
        .update(galleryItems)
        .set({ expiresAt: mediaExpiresAt(false, now) })
        .where(
          and(
            eq(galleryItems.userId, userId),
            isNull(galleryItems.expiresAt),
            isNull(galleryItems.deletedAt),
          ),
        );
    }
    return { kind: 'retired', subscriptionId };
  });
}

function elapsedSubscriptionReply(
  reply: FastifyReply,
  action: Exclude<ElapsedSubscriptionAction, { kind: 'missing' | 'still_live' | 'retired' }>,
) {
  switch (action.kind) {
    case 'payment_pending':
      return reply.status(409).send({
        error: 'subscription_payment_pending',
        subscriptionId: action.subscriptionId,
        orderId: action.orderId,
      });
    case 'payment_failed':
      return reply.status(409).send({
        error: 'subscription_payment_failed',
        subscriptionId: action.subscriptionId,
      });
    case 'renewal_pending':
      return reply.status(409).send({
        error: 'subscription_renewal_pending',
        subscriptionId: action.subscriptionId,
      });
  }
}

/** Best-effort immediate provider cancellation. The local lifecycle write is
 * already committed; the reconciliation loop retries the same agreement when
 * this network call fails or the process crashes between the two operations. */
async function syncTochkaCancellation(
  providerSubscriptionId: string | null | undefined,
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  if (!providerSubscriptionId) return;
  const provider = _billingShared.getPaymentProvider();
  if (provider.kind !== 'tochka') return;
  try {
    const snapshot = await provider.adapter.getSubscriptionStatus(providerSubscriptionId);
    const data = (snapshot.Data ?? snapshot.data ?? snapshot) as Record<string, unknown>;
    const operation = Array.isArray(data.Operation)
      ? ((data.Operation[0] as Record<string, unknown> | undefined) ?? {})
      : data;
    const raw = operation.status ?? operation.Status ?? data.status ?? data.Status;
    const status =
      raw && typeof raw === 'object'
        ? String(
            (raw as Record<string, unknown>).value ?? (raw as Record<string, unknown>).Value ?? '',
          )
        : String(raw ?? '');
    if (['CANCELED', 'CANCELLED'].includes(status.toUpperCase().replace(/[-_]/g, ''))) return;
    await provider.adapter.setSubscriptionStatus(providerSubscriptionId, 'Cancelled');
  } catch (error) {
    log.warn(
      { err: error, providerSubscriptionId },
      'subscription: provider cancellation deferred to reconciliation',
    );
  }
}

export function setupSubscriptionRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
): void {
  app.get('/v1/billing/media-storage', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    return { paid: await hasPaidMediaStorage(db, session.user.id, new Date()) };
  });

  app.post('/v1/billing/subscribe', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const tier = parsed.data.tier;

    let existing = await findLifecycleSubscription(db, session.user.id);
    if (existing && existing.currentPeriodEnd <= new Date()) {
      const action = await resolveElapsedSubscription(session.user.id, existing.id, new Date());
      if (
        action.kind === 'payment_pending' ||
        action.kind === 'payment_failed' ||
        action.kind === 'renewal_pending'
      ) {
        return elapsedSubscriptionReply(reply, action);
      }
      // Re-read after the locked transition. A concurrent settlement may have
      // created a live row while the elapsed one was being retired; in that
      // case the new row still owns the user's single checkout subject.
      existing = await findLifecycleSubscription(db, session.user.id);
    }
    if (existing) {
      return reply.status(409).send({ error: 'already_subscribed', subscriptionId: existing.id });
    }

    const catalogRows = await db
      .select()
      .from(subscriptionsCatalog)
      .where(eq(subscriptionsCatalog.tier, tier))
      .limit(1);
    const cat = catalogRows[0];
    if (!cat || !cat.isActive) {
      return reply.status(400).send({ error: 'tier_not_available' });
    }

    const provider = _billingShared.getPaymentProvider();
    if (provider.kind === 'yookassa' && provider.adapter.mode === 'stub' && _billingShared.isProd) {
      return reply.status(500).send({ error: 'psp_not_configured' });
    }

    // W1-0 — intent-first. The subject is the USER: two tiers settling would be
    // two subscriptions and two grants, so a second submit loses regardless of
    // which tier it names.
    // An unbound in-flight order for the SAME tier is resumed through its own
    // id (the PSP idempotency key), so no second payment can be created. A
    // bound order is refused unless its payment is provably dead at the PSP.
    const intent = await acquireBillingIntent(
      {
        id: nid(),
        userId: session.user.id,
        kind: 'subscription',
        tierOrPackId: tier,
        amountRub: cat.priceRub,
        psp:
          provider.kind === 'tochka'
            ? 'tochka'
            : provider.adapter.mode === 'stub'
              ? 'yookassa-stub'
              : 'yookassa',
        ourStatus: 'pending',
        metadata: {
          purpose: 'subscribe',
          tier,
        },
        intentKey: SUBSCRIBE_INTENT_KEY,
      },
      {
        probe: async (id) => {
          if (provider.kind === 'yookassa') return provider.adapter.retrievePayment(id);
          try {
            const info = await provider.adapter.getPaymentInfo(id);
            return { status: typeof info.status === 'string' ? info.status : 'unknown' };
          } catch {
            return null;
          }
        },
      },
    );
    if (!intent.ok) {
      req.log.info(
        { userId: session.user.id, tier, existingOrderId: intent.existingOrderId },
        'subscribe: checkout already in progress',
      );
      return reply
        .status(409)
        .send({ error: 'checkout_in_progress', orderId: intent.existingOrderId });
    }
    const { orderId, amountRub } = intent;

    const returnUrl = `${WEB_PUBLIC_URL}/billing/return?orderId=${orderId}`;
    const contact = await _billingShared.customerContactFor(session.user.id);
    const customerEmail = contact.email ?? parsed.data.customerEmail ?? null;
    let payment: { confirmationUrl: string; providerPaymentId: string; status: string };
    let providerSubscriptionId: string | undefined;
    let consumerId: string | undefined;
    try {
      if (provider.kind === 'tochka') {
        const created = await provider.adapter.createSubscription({
          amountRub,
          orderId,
          purpose: `Подписка ${cat.title}`,
          returnUrl,
          customerEmail,
          customerPhone: contact.phone,
          itemTitle: cat.title,
        });
        payment = {
          confirmationUrl: created.confirmationUrl,
          providerPaymentId: created.providerSubscriptionId,
          status: created.status,
        };
        providerSubscriptionId = created.providerSubscriptionId;
        consumerId = created.consumerId;
      } else {
        payment = await provider.adapter.createPayment({
          amountRub,
          orderId,
          userId: session.user.id,
          itemId: tier,
          kind: 'subscription',
          returnUrl,
          description: `Подписка ${cat.title}`,
          customerEmail,
          customerPhone: contact.phone,
          receiptDescription: `Подписка ${cat.title}`,
        });
      }
    } catch (err) {
      // Only a proven refusal frees the subject — see billing-intent.ts.
      const outcome = createFailureOutcomeOf(err);
      if (outcome === 'rejected') await releaseBillingIntent(orderId);
      req.log.error(
        { err, orderId, outcome, intentHeld: outcome !== 'rejected' },
        'subscribe: yookassa create failed',
      );
      return reply.status(502).send({ error: 'psp_unavailable' });
    }
    await attachPspPayment(orderId, payment).catch((err: unknown) => {
      req.log.error({ err, orderId }, 'subscribe: psp payment attach failed');
    });
    if (provider.kind === 'tochka') {
      await db
        .update(orders)
        .set({
          metadata: {
            purpose: 'subscribe',
            tier,
            paymentLinkId: orderId,
            ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
            ...(consumerId ? { consumerId } : {}),
            // Wholesale replace — keep the confirmation URL attachPspPayment
            // just merged, or the return page has nothing to resume from.
            ...(payment.confirmationUrl ? { confirmationUrl: payment.confirmationUrl } : {}),
          },
        })
        .where(eq(orders.id, orderId));
    }
    req.log.info(
      { orderId, tier, userId: session.user.id, provider: provider.kind },
      'subscribe: order created',
    );
    return reply.status(201).send({ orderId, confirmationUrl: payment.confirmationUrl });
  });

  app.post('/v1/billing/cancel-subscription', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const result = await db.transaction(async (tx) => {
      await lockMediaStorageUser(tx, session.user.id);
      // Read through `tx`, so the row stays inside the advisory lock this
      // transaction already holds — the reason the selector takes an executor.
      const sub = await findLifecycleSubscription(tx, session.user.id);
      if (!sub) return null;
      const now = new Date();
      if (sub.currentPeriodEnd <= now) {
        await tx
          .update(subscriptions)
          .set({ status: 'canceled' })
          .where(eq(subscriptions.id, sub.id));
        if (!(await hasPaidMediaStorage(tx, session.user.id, now))) {
          await tx
            .update(galleryItems)
            .set({ expiresAt: mediaExpiresAt(false, now) })
            .where(
              and(
                eq(galleryItems.userId, session.user.id),
                isNull(galleryItems.expiresAt),
                isNull(galleryItems.deletedAt),
              ),
            );
        }
        return {
          ok: true as const,
          status: 'canceled' as const,
          providerSubscriptionId: sub.pspSubscriptionId,
        };
      }
      await tx
        .update(subscriptions)
        .set({ cancelAtPeriodEnd: true })
        .where(eq(subscriptions.id, sub.id));
      return {
        ok: true as const,
        status: 'cancel_at_period_end' as const,
        providerSubscriptionId: sub.pspSubscriptionId,
      };
    });
    if (!result) return reply.status(404).send({ error: 'no_active_subscription' });
    await syncTochkaCancellation(result.providerSubscriptionId, req.log);
    const { providerSubscriptionId: _providerSubscriptionId, ...publicResult } = result;
    return publicResult;
  });

  app.post('/v1/billing/renew-toggle', async (req, reply) => {
    // Toggle auto-renewal on/off — flips cancelAtPeriodEnd. Defaults
    // start at true (opt-in) per the brief's anti-pattern wedge §W3.Tue.
    const session = await requireSession(req, reply);
    if (!session) return;
    // #14 audit: validate with Zod so string "true" etc. get a 400 not a
    // silent coercion to Boolean.
    const parsed = renewToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const desired = parsed.data.autoRenew;
    let sub = await findLifecycleSubscription(db, session.user.id);
    if (!sub) return reply.status(404).send({ error: 'no_active_subscription' });
    if (sub.currentPeriodEnd <= new Date()) {
      const action = await resolveElapsedSubscription(session.user.id, sub.id, new Date());
      if (
        action.kind === 'payment_pending' ||
        action.kind === 'payment_failed' ||
        action.kind === 'renewal_pending'
      ) {
        return elapsedSubscriptionReply(reply, action);
      }
      if (action.kind === 'retired') {
        return reply.status(409).send({
          error: 'subscription_expired',
          subscriptionId: action.subscriptionId,
        });
      }
      // Re-read after the locked transition. A concurrent renewal may have
      // moved the lifecycle row forward; never flip renewal on a stale period.
      sub = await findLifecycleSubscription(db, session.user.id);
      if (!sub || sub.currentPeriodEnd <= new Date()) {
        return reply.status(409).send({
          error: 'subscription_expired',
          subscriptionId: sub?.id ?? action.subscriptionId,
        });
      }
    }
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: !desired })
      .where(eq(subscriptions.id, sub.id));
    if (!desired) await syncTochkaCancellation(sub.pspSubscriptionId, req.log);
    return { ok: true, autoRenew: desired };
  });

  app.post('/v1/billing/upgrade', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = upgradeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const newTier = parsed.data.newTier;
    let sub = await findLifecycleSubscription(db, session.user.id);
    if (!sub) return reply.status(404).send({ error: 'no_active_subscription' });
    if (sub.currentPeriodEnd <= new Date()) {
      const action = await resolveElapsedSubscription(session.user.id, sub.id, new Date());
      if (
        action.kind === 'payment_pending' ||
        action.kind === 'payment_failed' ||
        action.kind === 'renewal_pending'
      ) {
        return elapsedSubscriptionReply(reply, action);
      }
      if (action.kind === 'retired') {
        return reply.status(409).send({
          error: 'subscription_expired',
          subscriptionId: action.subscriptionId,
        });
      }
      // A worker may have renewed the row while the request was waiting for
      // the user lock. Use the post-lock lifecycle row for pricing, never the
      // stale elapsed snapshot.
      sub = await findLifecycleSubscription(db, session.user.id);
      if (!sub || sub.currentPeriodEnd <= new Date()) {
        return reply.status(409).send({
          error: 'subscription_expired',
          subscriptionId: sub?.id ?? action.subscriptionId,
        });
      }
    }
    if (sub.tier === newTier) {
      return reply.status(400).send({ error: 'already_on_tier' });
    }

    const catalogRows = await db
      .select()
      .from(subscriptionsCatalog)
      .where(eq(subscriptionsCatalog.tier, newTier))
      .limit(1);
    const newCat = catalogRows[0];
    if (!newCat || !newCat.isActive) {
      return reply.status(400).send({ error: 'tier_not_available' });
    }
    if (newCat.priceRub <= sub.priceRub) {
      return reply.status(400).send({ error: 'downgrade_not_supported' });
    }

    const now = new Date();
    const msRemaining = sub.currentPeriodEnd.getTime() - now.getTime();
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
    const proratedAmount = Math.max(
      1,
      Math.round((daysRemaining * (newCat.priceRub - sub.priceRub)) / _internal.CYCLE_DAYS),
    );

    const provider = _billingShared.getPaymentProvider();
    if (provider.kind === 'yookassa' && provider.adapter.mode === 'stub' && _billingShared.isProd) {
      return reply.status(500).send({ error: 'psp_not_configured' });
    }
    // W1-0 — intent-first. The subject is the subscription AND the target tier:
    // «Старт → Плюс» and «Старт → Про» are different purchases at different
    // prices, so they must not be collapsed into one another's payment.
    // ONE upgrade in flight per subscription. A second one — to any target —
    // would be priced off a baseline the first is about to move, so it is
    // refused rather than collapsed. Only the identical unbound target resumes.
    const intent = await acquireBillingIntent(
      {
        id: nid(),
        userId: session.user.id,
        kind: 'subscription',
        tierOrPackId: newTier,
        amountRub: proratedAmount,
        psp:
          provider.kind === 'tochka'
            ? 'tochka'
            : provider.adapter.mode === 'stub'
              ? 'yookassa-stub'
              : 'yookassa',
        ourStatus: 'pending',
        metadata: {
          purpose: 'upgrade',
          subscriptionId: sub.id,
          fromTier: sub.tier,
          toTier: newTier,
          proratedDays: daysRemaining,
        },
        intentKey: upgradeIntentKey(sub.id),
      },
      {
        probe: async (id) => {
          if (provider.kind === 'yookassa') return provider.adapter.retrievePayment(id);
          try {
            const info = await provider.adapter.getPaymentInfo(id);
            return { status: typeof info.status === 'string' ? info.status : 'unknown' };
          } catch {
            return null;
          }
        },
      },
    );
    if (!intent.ok) {
      req.log.info(
        { userId: session.user.id, subscriptionId: sub.id, newTier },
        'upgrade: checkout already in progress',
      );
      return reply
        .status(409)
        .send({ error: 'checkout_in_progress', orderId: intent.existingOrderId });
    }
    const { orderId, amountRub } = intent;

    const returnUrl = `${WEB_PUBLIC_URL}/billing/return?orderId=${orderId}`;
    const contact = await _billingShared.customerContactFor(session.user.id);
    const customerEmail = contact.email ?? parsed.data.customerEmail ?? null;
    let payment: { confirmationUrl: string; providerPaymentId: string; status: string };
    try {
      if (provider.kind === 'tochka') {
        const created = await provider.adapter.createPayment({
          amountRub,
          orderId,
          kind: 'subscription',
          purpose: `Апгрейд подписки до ${newCat.title}`,
          returnUrl,
          customerEmail,
          customerPhone: contact.phone,
          itemTitle: `Апгрейд подписки до ${newCat.title}`,
        });
        payment = {
          confirmationUrl: created.confirmationUrl,
          providerPaymentId: created.providerPaymentId,
          status: created.status,
        };
      } else {
        payment = await provider.adapter.createPayment({
          amountRub,
          orderId,
          userId: session.user.id,
          itemId: newTier,
          kind: 'subscription',
          returnUrl,
          description: `Апгрейд подписки до ${newCat.title}`,
          customerEmail,
          customerPhone: contact.phone,
          receiptDescription: `Апгрейд подписки до ${newCat.title}`,
        });
      }
    } catch (err) {
      // Only a proven refusal frees the subject — see billing-intent.ts.
      const outcome = createFailureOutcomeOf(err);
      if (outcome === 'rejected') await releaseBillingIntent(orderId);
      req.log.error(
        { err, orderId, outcome, intentHeld: outcome !== 'rejected' },
        'upgrade: yookassa create failed',
      );
      return reply.status(502).send({ error: 'psp_unavailable' });
    }
    await attachPspPayment(orderId, payment).catch((err: unknown) => {
      req.log.error({ err, orderId }, 'upgrade: psp payment attach failed');
    });
    return reply.status(201).send({
      orderId,
      confirmationUrl: payment.confirmationUrl,
      proratedAmount,
      proratedDays: daysRemaining,
    });
  });

  // Schedule a DOWNGRADE to a cheaper tier, effective at the current period end.
  // No payment, no proration: the user keeps their current tier + tokens until
  // the paid month ends, then the cycle worker swaps to `pendingTier`. Scheduling
  // enables renewal (cancelAtPeriodEnd=false) so the change actually takes effect
  // — a downgrade is a commitment to continue on the cheaper plan.
  app.post('/v1/billing/downgrade', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = downgradeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const newTier = parsed.data.newTier;
    let sub = await findLifecycleSubscription(db, session.user.id);
    if (!sub) return reply.status(404).send({ error: 'no_active_subscription' });
    if (sub.currentPeriodEnd <= new Date()) {
      const action = await resolveElapsedSubscription(session.user.id, sub.id, new Date());
      if (
        action.kind === 'payment_pending' ||
        action.kind === 'payment_failed' ||
        action.kind === 'renewal_pending'
      ) {
        return elapsedSubscriptionReply(reply, action);
      }
      if (action.kind === 'retired') {
        return reply.status(409).send({
          error: 'subscription_expired',
          subscriptionId: action.subscriptionId,
        });
      }
      sub = await findLifecycleSubscription(db, session.user.id);
      if (!sub || sub.currentPeriodEnd <= new Date()) {
        return reply.status(409).send({
          error: 'subscription_expired',
          subscriptionId: sub?.id ?? action.subscriptionId,
        });
      }
    }
    if (sub.tier === newTier) {
      return reply.status(400).send({ error: 'already_on_tier' });
    }

    const catalogRows = await db
      .select()
      .from(subscriptionsCatalog)
      .where(eq(subscriptionsCatalog.tier, newTier))
      .limit(1);
    const newCat = catalogRows[0];
    if (!newCat || !newCat.isActive) {
      return reply.status(400).send({ error: 'tier_not_available' });
    }
    // A downgrade must be strictly cheaper — upgrades go through /upgrade (paid,
    // prorated, immediate).
    if (newCat.priceRub >= sub.priceRub) {
      return reply.status(400).send({ error: 'not_a_downgrade' });
    }

    await db
      .update(subscriptions)
      .set({ pendingTier: newTier, cancelAtPeriodEnd: false })
      .where(eq(subscriptions.id, sub.id));
    req.log.info(
      { subscriptionId: sub.id, fromTier: sub.tier, toTier: newTier },
      'downgrade: scheduled',
    );
    return reply.status(200).send({
      ok: true,
      pendingTier: newTier,
      effectiveAt: sub.currentPeriodEnd,
    });
  });

  // Cancel a scheduled downgrade — the subscription stays on its current tier.
  app.post('/v1/billing/cancel-downgrade', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const sub = await findLifecycleSubscription(db, session.user.id);
    if (!sub) return reply.status(404).send({ error: 'no_active_subscription' });
    if (!sub.pendingTier) {
      return reply.status(404).send({ error: 'no_pending_downgrade' });
    }
    await db.update(subscriptions).set({ pendingTier: null }).where(eq(subscriptions.id, sub.id));
    return reply.status(200).send({ ok: true });
  });

  app.get('/v1/billing/subscription', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const sub = await findLifecycleSubscription(db, session.user.id);
    if (!sub) return null;

    // Plan title for "plan + cycle" UI framing, and credits remaining in THIS
    // cycle's included allowance = creditsPerCycle − |spend since period start|.
    // (Spends draw from the combined pool; for plan framing we attribute this
    // cycle's spend against the cycle allowance — packs/bonus show as surplus.)
    const [catalog] = await db
      .select({ title: subscriptionsCatalog.title })
      .from(subscriptionsCatalog)
      .where(eq(subscriptionsCatalog.tier, sub.tier))
      .limit(1);
    // Scheduled downgrade target (if any) + its display title for the UI.
    let pendingTitle: string | null = null;
    if (sub.pendingTier) {
      const [pendingCat] = await db
        .select({ title: subscriptionsCatalog.title })
        .from(subscriptionsCatalog)
        .where(eq(subscriptionsCatalog.tier, sub.pendingTier))
        .limit(1);
      pendingTitle = pendingCat?.title ?? null;
    }
    const liveBucket = sql`${creditBuckets.expiresAt} IS NULL OR ${creditBuckets.expiresAt} > now()`;
    const [cycleBucketTotals] = await db
      .select({
        count: sql<number>`COUNT(*)::int`,
        remaining: sql<number>`COALESCE(SUM(
          ${creditBuckets.granted} - ${creditBuckets.consumed} - ${creditBuckets.reserved}
        ) FILTER (WHERE ${liveBucket}), 0)::int`,
        used: sql<number>`COALESCE(SUM(${creditBuckets.consumed}) FILTER (WHERE ${liveBucket}), 0)::int`,
      })
      .from(creditBuckets)
      .where(
        and(
          eq(creditBuckets.relatedSubscriptionId, sub.id),
          eq(creditBuckets.cycleNumber, sub.cycleNumber),
        ),
      );

    let remainingThisCycle: number;
    let usedThisCycle: number;
    if (Number(cycleBucketTotals?.count ?? 0) > 0) {
      // `used` is settled consumption only. Reservations reduce `remaining`,
      // but remain in-flight work rather than completed use.
      remainingThisCycle = Math.max(0, Number(cycleBucketTotals?.remaining ?? 0));
      usedThisCycle = Number(cycleBucketTotals?.used ?? 0);
    } else {
      // Pre-W2-a subscriptions have no per-cycle buckets. Preserve the old
      // estimate for that legacy state rather than presenting its balance as 0.
      const [spendRow] = await db
        .select({ sum: sql<string>`COALESCE(SUM(${creditTransactions.amount}), 0)` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, session.user.id),
            eq(creditTransactions.account, 'spend'),
            gte(creditTransactions.createdAt, sub.currentPeriodStart),
          ),
        );
      usedThisCycle = Math.abs(Number(spendRow?.sum ?? 0));
      remainingThisCycle = Math.max(0, sub.creditsPerCycle - usedThisCycle);
    }

    // W0 — `planAccess`: the LIVE plan, and the only field model-access surfaces
    // may read. It is built wholly from the one row the entitlement predicate
    // chose, never mixed with the manageable row above: an older-live «Старт»
    // plus a newer-elapsed «Плюс» must not produce a payload that says «Старт»
    // in one field and «Плюс» in the next.
    const live = await resolveLivePlanSubscription(db, session.user.id);
    let liveTitle: string | null = live?.id === sub.id ? (catalog?.title ?? null) : null;
    if (live && live.id !== sub.id) {
      const [liveCat] = await db
        .select({ title: subscriptionsCatalog.title })
        .from(subscriptionsCatalog)
        .where(eq(subscriptionsCatalog.tier, live.tier))
        .limit(1);
      liveTitle = liveCat?.title ?? null;
    }

    // `planAccessBlock` — WHY the two rows disagree. The client must never
    // re-derive this: today the only cause is an ended period, but once renewal
    // actually charges (W3), a declined card lands the subscription in
    // `past_due` with an elapsed period. That customer's subscription is still
    // alive, and telling them to cancel and re-subscribe would be a lie.
    const planAccessBlock = live
      ? null
      : {
          reason:
            sub.status === 'past_due' ? ('payment_failed' as const) : ('period_ended' as const),
          subscriptionId: sub.id,
          tier: sub.tier,
          currentPeriodEnd: sub.currentPeriodEnd,
        };

    return {
      id: sub.id,
      tier: sub.tier,
      title: catalog?.title ?? null,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      autoRenew: !sub.cancelAtPeriodEnd,
      priceRub: sub.priceRub,
      creditsPerCycle: sub.creditsPerCycle,
      pendingTier: sub.pendingTier,
      pendingTitle,
      usedThisCycle,
      remainingThisCycle,
      cycleNumber: sub.cycleNumber,
      planAccess: live
        ? {
            tier: live.tier,
            title: liveTitle,
            priceRub: live.priceRub,
            currentPeriodEnd: live.currentPeriodEnd,
            status: live.status,
            pendingTier: live.pendingTier,
          }
        : null,
      planAccessBlock,
    };
  });

  app.get('/v1/billing/tiers', async () => {
    const rows = await db
      .select()
      .from(subscriptionsCatalog)
      .where(eq(subscriptionsCatalog.isActive, true))
      .orderBy(subscriptionsCatalog.sortOrder);
    return rows;
  });
}
