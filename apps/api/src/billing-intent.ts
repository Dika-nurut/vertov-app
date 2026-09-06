import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { db, orders, schema } from '@seed/db';
import { type CreateFailureOutcome, PaymentCreateError } from '@seed/provider-yookassa';

/**
 * W1-0 — intent-first checkout.
 *
 * Every paid entry point (pack checkout, subscribe, upgrade) inserts its local
 * order row BEFORE calling the PSP, using the order id as the PSP idempotency
 * key. The insert competes for a partial unique index — `orders_live_intent_uniq`
 * on `(user_id, intent_key) WHERE our_status = 'pending' AND intent_key IS NOT
 * NULL` — so a second concurrent submit for the same subject loses the insert
 * and never reaches YooKassa. No lock is held across the PSP's HTTP call.
 *
 * There is deliberately NO time-based release of a claimed intent. An earlier
 * revision expired the claim after 24h so an abandoned checkout would not dead-
 * end the customer; adversarial review showed that valve is precisely how two
 * live payments come to exist for one purchase, because we cannot ask YooKassa
 * whether the abandoned confirmation link is still payable. A claim is released
 * only by evidence:
 *
 *   - the provider REFUSED the create outright (no payment exists), or
 *   - the order left `pending` — `payment.canceled` tombstones it, which is the
 *     provider telling us the abandoned payment is dead, or
 *   - the same order is resumed through its own idempotency key (below).
 *
 * Cancelling a still-live payment on demand needs a PSP capability the adapter
 * does not have; that is W1-1's job, and it is what will let an impatient
 * customer restart a checkout early.
 */

/** The unique index the intent race is decided by. */
const INTENT_CONSTRAINT = 'orders_live_intent_uniq';

/** Subjects. Two intents collide iff they name the same subject for one user. */
export function packIntentKey(packId: string): string {
  return `pack:${packId}`;
}

/**
 * Subscribing is keyed on the USER, not the tier: two plans settling would be
 * two subscription rows and two grants, and canon §5 says webhook order is not
 * guaranteed, so the cheaper plan can be the one that wins.
 */
export const SUBSCRIBE_INTENT_KEY = 'subscribe';

/**
 * An upgrade is keyed on the SUBSCRIPTION ALONE — never on the target tier.
 *
 * Keying on the target was this design's own error, caught in review: two
 * upgrades from «Старт» to different targets got different keys, so both
 * payments were created and BOTH were priced off «Старт». If «Про» settles
 * first it moves the subscription up, and the «Плюс» payment then arrives
 * carrying a baseline that no longer exists — it grants nothing (its delta is
 * negative) and rewrites the subscription DOWN to «Плюс». One upgrade in flight
 * per subscription; the next one is priced against whatever tier it lands on.
 */
export function upgradeIntentKey(subscriptionId: string): string {
  return `upgrade:${subscriptionId}`;
}

type PgError = { code?: string; constraint?: string; cause?: unknown };

/**
 * Losing the intent race is a unique violation on ONE named index — never a
 * blanket "any 23505", which would swallow an unrelated constraint bug and
 * report it to the customer as "you are already buying this".
 *
 * drizzle wraps the driver error, so the pg fields live on `cause`.
 */
function isIntentConflict(err: unknown): boolean {
  for (let e = err as PgError | null | undefined; e; e = e.cause as PgError | null | undefined) {
    if (e.code === '23505' && e.constraint === INTENT_CONSTRAINT) return true;
  }
  return false;
}

type OrderInsert = typeof orders.$inferInsert;
type OrderRow = typeof orders.$inferSelect;
type IntentExecutor = Pick<PgDatabase<any, typeof schema>, 'select'>;

/**
 * A live billing intent is exactly the W1-0 partial-index predicate: a pending
 * order that still owns an intent key. Keep this selector here so support and
 * checkout cannot drift into different meanings of “in flight”.
 */
export async function findLiveBillingIntent(
  executor: IntentExecutor,
  userId: string,
): Promise<OrderRow | null> {
  const [row] = await executor
    .select()
    .from(orders)
    .where(
      and(eq(orders.userId, userId), eq(orders.ourStatus, 'pending'), isNotNull(orders.intentKey)),
    )
    .orderBy(desc(orders.createdAt))
    .limit(1);
  return row ?? null;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'in_progress'; existing: OrderRow | null };

/**
 * Insert the order row and claim its subject, or lose the race.
 *
 * Runs OUTSIDE any transaction — a losing insert must not poison a caller's tx,
 * and nothing may be held while the PSP call that follows is in flight.
 */
export async function claimBillingIntent(
  values: OrderInsert & { intentKey: string },
): Promise<ClaimResult> {
  try {
    await db.insert(orders).values(values);
    return { ok: true };
  } catch (err) {
    if (!isIntentConflict(err)) throw err;
    const [existing] = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, values.userId),
          eq(orders.intentKey, values.intentKey),
          eq(orders.ourStatus, 'pending'),
        ),
      )
      .limit(1);
    return { ok: false, reason: 'in_progress', existing: existing ?? null };
  }
}

/**
 * Can this in-progress order be driven to the PSP again instead of refused?
 *
 * Only when no payment reference was ever attached — meaning the previous
 * attempt died between the insert and the attach (concurrent submit still in
 * flight, create timed out, attach failed). Re-driving it uses the SAME order
 * id, which is the PSP idempotency key, so the provider returns the payment it
 * already made rather than making a second one. That is the whole reason this
 * is safe, and it is why an order that already HAS a payment id is never
 * resumed — re-offering an abandoned link is a different, unsafe thing.
 *
 * The subject must also still describe the same purchase: `subscribe` is keyed
 * on the user and `upgrade` on the subscription, so the in-flight order can name
 * a different tier than the one being asked for now. Resuming into that would
 * hand the customer a payment for a plan they did not just choose.
 */
export function isResumable(existing: OrderRow | null, requestedItemId: string): boolean {
  return (
    existing !== null &&
    existing.pspPaymentId === null &&
    existing.ourStatus === 'pending' &&
    existing.tierOrPackId === requestedItemId
  );
}

/**
 * Ask the provider whether a payment is still payable. Structurally the
 * adapter's `retrievePayment`; typed narrowly here so this module needs nothing
 * from the adapter but the one field it reasons about.
 */
export type PaymentProbe = (paymentId: string) => Promise<{ status: string } | null>;

/**
 * How long an in-flight order must have existed before we will spend a network
 * call asking about it. A genuine concurrent double-submit is seconds old and
 * must be refused locally, with no PSP round-trip on the hot path.
 */
export const INTENT_PROBE_MIN_AGE_MS = 2 * 60 * 1000;

/** At most one provider question per order per this window, however often the customer retries. */
export const INTENT_PROBE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * ЮKassa's terminal, unpayable status. Expiry is not a separate status: an
 * unpaid payment is auto-canceled with `cancellation_details.reason =
 * expired_on_confirmation`, so `canceled` is the single positive signal that a
 * confirmation link can never be paid.
 *
 * Everything else is NOT proof of death — `pending` and `waiting_for_capture`
 * are alive, and `succeeded` is money we are about to be told about.
 */
function isDeadPaymentStatus(status: string): boolean {
  return status === 'canceled';
}

/**
 * An abandoned checkout holds its subject until the provider says the payment
 * is dead. Normally that arrives as a `payment.canceled` webhook, but ЮKassa's
 * confirmation window is method-dependent and undocumented, so waiting for it
 * can lock a customer out of re-buying for an unknown time. When they try
 * again, ask.
 *
 * FAILS CLOSED, on the same principle as the create classifier: a throw, a
 * timeout, a payment the provider does not know, or any non-terminal status all
 * leave the subject held. Only a positive `canceled` releases it. An ambiguous
 * provider answer is never proof.
 *
 * Returns true only if the order was tombstoned — which frees the subject
 * through the partial index predicate, exactly as a `payment.canceled` webhook
 * does.
 */
export async function releaseIfPaymentIsDead(
  existing: OrderRow,
  probe: PaymentProbe,
  now: Date = new Date(),
): Promise<{ released: boolean; probed: boolean }> {
  if (!existing.pspPaymentId || existing.ourStatus !== 'pending') {
    return { released: false, probed: false };
  }
  if (now.getTime() - existing.createdAt.getTime() < INTENT_PROBE_MIN_AGE_MS) {
    return { released: false, probed: false };
  }
  if (
    existing.intentProbedAt &&
    now.getTime() - existing.intentProbedAt.getTime() < INTENT_PROBE_COOLDOWN_MS
  ) {
    return { released: false, probed: false };
  }

  // Stamp BEFORE asking. A provider that is slow or failing must not be asked
  // again by the customer's next click, so the cooldown has to start whether
  // the call succeeds or not.
  await db
    .update(orders)
    .set({ intentProbedAt: now })
    .where(and(eq(orders.id, existing.id), eq(orders.ourStatus, 'pending')));

  let retrieved: Awaited<ReturnType<PaymentProbe>>;
  try {
    retrieved = await probe(existing.pspPaymentId);
  } catch {
    return { released: false, probed: true };
  }
  if (!retrieved || !isDeadPaymentStatus(retrieved.status)) {
    return { released: false, probed: true };
  }

  // Tombstone, guarded on `pending` so a settlement that landed while we were
  // asking is never overwritten. `intent_key` is left in place for forensics —
  // the index predicate keys on the status, so the subject is already free.
  const tombstoned = await db
    .update(orders)
    .set({ ourStatus: 'failed', pspStatus: retrieved.status })
    .where(and(eq(orders.id, existing.id), eq(orders.ourStatus, 'pending')))
    .returning({ id: orders.id });
  return { released: tombstoned.length > 0, probed: true };
}

export type IntentOutcome =
  | { ok: true; orderId: string; amountRub: number; resumed: boolean }
  | { ok: false; existingOrderId: string | null };

/**
 * The whole front half of checkout: claim the subject, or work out whether the
 * thing holding it can be safely stood aside.
 *
 * Three ways to end up with an order to drive:
 *   1. the claim won outright;
 *   2. an unbound in-flight order is RESUMED through its own id (same PSP
 *      idempotency key, so no second payment can exist);
 *   3. the in-flight order's payment is provably dead at the provider, so it is
 *      tombstoned and a fresh intent takes the subject.
 *
 * Anything else is refused. One re-claim attempt after a release, because
 * another request may have taken the freed subject in between.
 */
export async function acquireBillingIntent(
  values: OrderInsert & { intentKey: string; amountRub: number },
  deps: { probe: PaymentProbe },
): Promise<IntentOutcome> {
  const requestedItemId = values.tierOrPackId;
  const claim = await claimBillingIntent(values);
  if (claim.ok) {
    return { ok: true, orderId: values.id!, amountRub: values.amountRub, resumed: false };
  }
  if (isResumable(claim.existing, requestedItemId)) {
    return {
      ok: true,
      orderId: claim.existing!.id,
      amountRub: claim.existing!.amountRub,
      resumed: true,
    };
  }
  if (!claim.existing) return { ok: false, existingOrderId: null };

  const { released } = await releaseIfPaymentIsDead(claim.existing, deps.probe);
  if (!released) return { ok: false, existingOrderId: claim.existing.id };

  const retry = await claimBillingIntent(values);
  if (retry.ok) {
    return { ok: true, orderId: values.id!, amountRub: values.amountRub, resumed: false };
  }
  if (isResumable(retry.existing, requestedItemId)) {
    return {
      ok: true,
      orderId: retry.existing!.id,
      amountRub: retry.existing!.amountRub,
      resumed: true,
    };
  }
  return { ok: false, existingOrderId: retry.existing?.id ?? null };
}

/**
 * How a failed `createPayment` should be read. Anything that is not an explicit
 * `PaymentCreateError` is an unexpected throw whose effect on the provider we
 * cannot know — so it is `unknown`, and the intent is held. Failing safe here is
 * the difference between one payment and two.
 */
export function createFailureOutcomeOf(err: unknown): CreateFailureOutcome {
  return err instanceof PaymentCreateError ? err.outcome : 'unknown';
}

/**
 * The provider REFUSED the create, so no payment exists and this order can
 * never be paid. Free the subject.
 *
 * Callers must only reach here on a proven rejection. On an ambiguous failure
 * the claim stays: a create that timed out may still have created the payment,
 * and releasing the slot there is exactly how a customer ends up charged twice.
 * The row stays `pending` either way — a payment that does turn out to exist
 * still settles through the order id in its metadata.
 */
export async function releaseBillingIntent(orderId: string): Promise<void> {
  await db
    .update(orders)
    .set({ intentKey: null })
    .where(and(eq(orders.id, orderId), eq(orders.ourStatus, 'pending')));
}

/**
 * Attach the PSP payment reference once the provider has answered.
 *
 * Guarded on `psp_payment_id IS NULL` so two racing resumes cannot rewrite an
 * already-bound order, and scoped to `pending` so it can never touch a settled
 * one.
 *
 * When the caller carries the buyer-facing `confirmationUrl`, it is merged into
 * the order's existing metadata JSONB (read first — other keys are never
 * overwritten). That URL is what lets a bounced Tochka form be resumed from
 * /billing/return instead of dead-ending on a 409. Absent URL = no-op.
 */
export async function attachPspPayment(
  orderId: string,
  payment: { providerPaymentId: string; status: string; confirmationUrl?: string },
): Promise<void> {
  const patch: {
    pspPaymentId: string;
    pspStatus: string;
    metadata?: Record<string, unknown>;
  } = {
    pspPaymentId: payment.providerPaymentId,
    pspStatus: payment.status,
  };
  if (payment.confirmationUrl) {
    const [row] = await db
      .select({ metadata: orders.metadata })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    const current =
      row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    patch.metadata = { ...current, confirmationUrl: payment.confirmationUrl };
  }
  await db
    .update(orders)
    .set(patch)
    .where(
      and(eq(orders.id, orderId), eq(orders.ourStatus, 'pending'), isNull(orders.pspPaymentId)),
    );
}
