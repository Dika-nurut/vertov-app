import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * beta_invites — closed-beta invite codes (W4.Fri).
 *
 * - code: opaque invite code, e.g. SEED-BETA-001
 * - cohort: logical group, e.g. 'tg-2026-05'
 * - usedAt / usedByUserId: stamped on first redemption
 *
 * 152-ФЗ: references users_app(id) only — no PII columns.
 * The deletion flow already cascades users_app rows; the FK is SET NULL
 * so invite analytics are preserved after account deletion.
 */
export const betaInvites = pgTable('beta_invites', {
  code: text('code').primaryKey(),
  cohort: text('cohort').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedByUserId: text('used_by_user_id'),
});
