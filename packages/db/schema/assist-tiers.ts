import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Admin ON/OFF state for the «Сценарий» assist text tiers (economy / standard /
 * max — the user-facing LLM picker). The tiers themselves (model, prices,
 * routing) stay code-configured in @seed/shared assist-tiers.ts and are NOT in
 * the `models` table (media-oriented: unitKind, creditCostPerUnit…); this table
 * holds ONLY the admin switch plus who/when. A disabled tier is refused
 * server-side by the assist route BEFORE any claim row or credit hold
 * (409 tier_disabled). A missing row reads as ACTIVE (never toggled; the seed
 * ships all three ACTIVE) — writes upsert.
 */
export const assistTierStates = pgTable('assist_tier_states', {
  tierId: text('tier_id').primaryKey(),
  isActive: boolean('is_active').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Admin user id from the toggle PATCH; NULL on a seeded row. */
  updatedBy: text('updated_by'),
});

export type AssistTierState = typeof assistTierStates.$inferSelect;
