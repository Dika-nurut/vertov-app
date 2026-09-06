import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { tierEnum } from './enums';

/**
 * Catalog of subscription tiers (one row per priced tier). Stored in the
 * DB rather than hardcoded so pricing or credit grants can change without
 * a redeploy. `tier` is the primary key — matches the enum used on
 * `subscriptions.tier`. Free is not in this table (no charge, no
 * credits-per-cycle).
 */
export const subscriptionsCatalog = pgTable('subscriptions_catalog', {
  tier: tierEnum('tier').primaryKey(),
  priceRub: integer('price_rub').notNull(),
  creditsPerCycle: integer('credits_per_cycle').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
