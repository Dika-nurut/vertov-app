import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { orderKindEnum, orderOurStatusEnum } from './enums';
import { usersApp } from './users';

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    kind: orderKindEnum('kind').notNull(),
    tierOrPackId: text('tier_or_pack_id').notNull(),
    amountRub: integer('amount_rub').notNull(),
    psp: text('psp').notNull().default('yookassa'),
    pspPaymentId: text('psp_payment_id').unique(),
    pspStatus: text('psp_status'),
    ourStatus: orderOurStatusEnum('our_status').notNull().default('pending'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    /** Order metadata: {purpose:'subscribe'|'upgrade'|'renewal',tier?,...}
     *  for subscription orders; null for pack orders. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /**
     * W1-0 — the *subject* of an in-progress buying intent, e.g. `pack:pack-m`,
     * `subscribe`, `upgrade:{subId}:{tier}`. Together with the partial unique
     * index below it is what actually prevents a duplicate payment: the order
     * row is inserted BEFORE the PSP is called, so a second concurrent checkout
     * for the same subject loses the insert and never reaches YooKassa.
     *
     * NULL means "holds no slot". That is the release valve, and it is
     * deliberately decoupled from `ourStatus`: an abandoned intent gets its key
     * cleared so the customer can buy again, while the row stays `pending` and
     * fully settleable. Expiry means "not eligible for re-offer" — never a
     * reason to discard a captured payment. System-created orders (renewals)
     * leave it NULL: they are not user-initiated and cannot be double-submitted.
     */
    intentKey: text('intent_key'),
    /**
     * W1-0 — when we last asked the PSP whether this order's payment is still
     * payable, so a blocked re-purchase can free the subject if it is dead.
     *
     * Exists purely to BOUND that question: the provider is consulted at most
     * once per cooldown per order, and never for an order young enough to be a
     * genuine concurrent double-submit. Without it every refused checkout would
     * be a network round-trip on a hot path.
     */
    intentProbedAt: timestamp('intent_probed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_user_id_idx').on(t.userId),
    index('orders_psp_payment_idx').on(t.pspPaymentId),
    uniqueIndex('orders_live_intent_uniq')
      .on(t.userId, t.intentKey)
      .where(sql`our_status = 'pending' AND intent_key IS NOT NULL`),
  ],
);
