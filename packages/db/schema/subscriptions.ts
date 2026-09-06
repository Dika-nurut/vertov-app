import { boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { subStatusEnum, tierEnum } from './enums';
import { usersApp } from './users';

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    tier: tierEnum('tier').notNull(),
    status: subStatusEnum('status').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** Monotonic cycle counter used in the worker idempotency key
     *  `sub:${id}:cycle:${cycleNumber}` so a re-run never double-grants. */
    cycleNumber: integer('cycle_number').notNull().default(1),
    /** Snapshot of catalog price at the moment of subscribe — used for
     *  prorated upgrade math even if the catalog row changes later. */
    priceRub: integer('price_rub').notNull().default(0),
    /** Snapshot of credits granted per cycle. */
    creditsPerCycle: integer('credits_per_cycle').notNull().default(0),
    /** Tochka recurring-operation id created during the initial card setup. */
    pspSubscriptionId: text('psp_subscription_id'),
    /** Tochka consumer id returned when a buyer saves a card. */
    pspConsumerId: text('psp_consumer_id'),
    /** Scheduled DOWNGRADE target — a cheaper tier the user chose to move to at
     *  the next renewal. Null = no pending change. Mirrors the `cancelAtPeriodEnd`
     *  "applies at period end" pattern: no mid-cycle proration, the renewal worker
     *  swaps tier→pendingTier + reseeds the price/credits snapshot and clears it. */
    pendingTier: tierEnum('pending_tier'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('subscriptions_user_id_idx').on(t.userId)],
);
