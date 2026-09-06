import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { creditAccountEnum } from './enums';
import { usersApp } from './users';

/**
 * Double-entry, append-only credit ledger.
 * Balance is derived (SUM of amount per user) — never stored.
 * idempotency_key is unique to make every mutation safe to retry.
 */
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    account: creditAccountEnum('account').notNull(),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    relatedJobId: text('related_job_id'),
    relatedOrderId: text('related_order_id'),
    bucketId: text('bucket_id').references(() => creditBuckets.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_tx_user_id_idx').on(t.userId),
    index('credit_tx_user_created_idx').on(t.userId, t.createdAt),
  ],
);

/** One immutable credit grant batch, and the authority for its remaining balance. */
export const creditBuckets = pgTable(
  'credit_buckets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    origin: text('origin').notNull(),
    priority: smallint('priority').notNull(),
    granted: integer('granted').notNull(),
    reserved: integer('reserved').notNull().default(0),
    consumed: integer('consumed').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantKey: text('grant_key').notNull().unique(),
    relatedOrderId: text('related_order_id'),
    relatedSubscriptionId: text('related_subscription_id'),
    cycleNumber: integer('cycle_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_buckets_spend_idx').on(
      t.userId,
      t.priority,
      sql`${t.expiresAt} ASC NULLS LAST`,
      t.createdAt,
    ),
    unique('credit_buckets_id_user_id_uniq').on(t.id, t.userId),
    check(
      'credit_buckets_origin_check',
      sql`${t.origin} IN ('legacy', 'subscription', 'pack', 'welcome', 'bonus', 'admin', 'refund', 'clawback')`,
    ),
    check(
      'credit_buckets_granted_check',
      sql`${t.granted} >= 0 OR ${t.origin} IN ('clawback', 'legacy')`,
    ),
    check('credit_buckets_reserved_consumed_check', sql`${t.reserved} >= 0 AND ${t.consumed} >= 0`),
    check(
      'credit_buckets_capacity_check',
      sql`${t.origin} IN ('clawback', 'legacy') OR ${t.granted} >= ${t.reserved} + ${t.consumed}`,
    ),
  ],
);

/** Attribution for reserve, settle, release, and clawback mutations. */
export const creditBucketAllocations = pgTable(
  'credit_bucket_allocations',
  {
    id: text('id').primaryKey(),
    bucketId: text('bucket_id').notNull(),
    userId: text('user_id').notNull(),
    jobId: text('job_id'),
    kind: text('kind').notNull(),
    amount: integer('amount').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.bucketId, t.userId],
      foreignColumns: [creditBuckets.id, creditBuckets.userId],
      name: 'credit_bucket_allocations_bucket_user_fkey',
    }).onDelete('cascade'),
    index('credit_bucket_allocations_user_job_kind_idx').on(t.userId, t.jobId, t.kind),
    check(
      'credit_bucket_allocations_kind_check',
      sql`${t.kind} IN ('reserve', 'commit', 'release', 'clawback')`,
    ),
    check('credit_bucket_allocations_amount_check', sql`${t.amount} > 0`),
  ],
);
