import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Persisted submit health; poll/download failures never write this table. */
export const routeLegHealth = pgTable('route_leg_health', {
  legIdentity: text('leg_identity').primaryKey(),
  consecutiveSubmitFailures: integer('consecutive_submit_failures').notNull().default(0),
  lastSubmitFailureAt: timestamp('last_submit_failure_at', { withTimezone: true }),
  lastSubmitSuccessAt: timestamp('last_submit_success_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
