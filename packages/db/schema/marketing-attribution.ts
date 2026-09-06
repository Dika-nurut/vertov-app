import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { usersApp } from './users';

/**
 * First-touch marketing attribution (funnel spec §5). One row per user,
 * written once via POST /v1/me/attribution. Idempotent: the server only inserts
 * if absent, never updates. No PII beyond what the user already gave us.
 */
export const marketingAttribution = pgTable('marketing_attribution', {
  userId: text('user_id')
    .primaryKey()
    .references(() => usersApp.id, { onDelete: 'cascade' }),
  utmSource: text('utm_source'),
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),
  referrer: text('referrer'),
  landingPath: text('landing_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
