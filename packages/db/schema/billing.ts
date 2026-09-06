import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { index } from 'drizzle-orm/pg-core';
import { refundStatusEnum } from './enums';

/**
 * Credit packs are the catalog of one-time purchases (kind = 'pack' in
 * `orders`). Stored in a table rather than hardcoded so prices can change
 * without a redeploy.
 */
export const creditPacks = pgTable('credit_packs', {
  id: text('id').primaryKey(),
  credits: integer('credits').notNull(),
  priceRub: integer('price_rub').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Outbox pattern (deferred W1.Fri review #7): the API writes a row here
 * inside the same DB transaction as the business write, then a worker
 * loop drains pending rows by enqueuing them on BullMQ. Eliminates the
 * orphan-job window when Redis is briefly down between commit and
 * `queue.add()`.
 */
/**
 * W1-0 — PSP webhook events we could not attribute to a local order.
 *
 * Before W1-0 such an event was answered `200 {ignored:'unknown_payment'}`,
 * which tells YooKassa the event was accepted: it stops retrying and the money
 * is stranded with no reconciliation path (canon §5). Now the event is retained
 * here and the route answers non-2xx so the provider retries on its own
 * schedule; the row is DELETED once the same event resolves, so whatever is
 * left in this table is exactly the set of payments still unattributed.
 */
export const billingUnresolvedEvents = pgTable(
  'billing_unresolved_events',
  {
    id: text('id').primaryKey(),
    /** PSP event name, e.g. `payment.succeeded`. */
    event: text('event').notNull(),
    /** `body.object.id` — the payment id, or the refund id for a refund event. */
    objectId: text('object_id').notNull(),
    /** The payment the event is about (differs from objectId on refunds). */
    pspPaymentId: text('psp_payment_id'),
    /** `metadata.orderId` we sent to the PSP, when the event carries it. */
    orderRef: text('order_ref'),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    attempts: integer('attempts').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('billing_unresolved_events_uniq').on(t.event, t.objectId)],
);

/**
 * Durable provider-refund ledger.
 *
 * A payment can have several partial refunds and the provider can answer the
 * refund request asynchronously. One row per provider refund operation keeps
 * those facts separate from the order lifecycle: a request is `pending` until
 * the provider confirms it, then the credit/subscription reversal marks it
 * `applied`. Both provider ids and our refund UID are unique anchors, so a
 * retry cannot create a second clawback or collapse two legitimate partials.
 */
export const billingRefunds = pgTable(
  'billing_refunds',
  {
    id: text('id').primaryKey(),
    psp: text('psp').notNull(),
    orderId: text('order_id').notNull(),
    pspPaymentId: text('psp_payment_id').notNull(),
    refundUid: text('refund_uid').notNull(),
    providerRefundId: text('provider_refund_id'),
    amountRub: numeric('amount_rub', { precision: 10, scale: 2 }).notNull(),
    status: refundStatusEnum('status').notNull().default('pending'),
    providerStatus: text('provider_status'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('billing_refunds_psp_uid_uniq').on(t.psp, t.refundUid),
    uniqueIndex('billing_refunds_provider_id_uniq')
      .on(t.psp, t.providerRefundId)
      .where(sql`${t.providerRefundId} IS NOT NULL`),
    index('billing_refunds_payment_idx').on(t.psp, t.pspPaymentId),
    index('billing_refunds_order_idx').on(t.orderId, t.status),
  ],
);

export const outboxJobs = pgTable('outbox_jobs', {
  id: text('id').primaryKey(),
  queueName: text('queue_name').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  jobId: text('job_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  /**
   * Earliest time this row may be retried. NULL = eligible now. Written by the
   * drainer when a settlement (money) row fails, so an unreachable ledger is
   * retried with a capped backoff instead of every drain tick — settlement rows
   * are never dropped by the attempt ceiling, so pacing is what keeps a stuck
   * one from starving the batch.
   */
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
});
