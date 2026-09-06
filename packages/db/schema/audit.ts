import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Append-only audit log.
 * Application code MUST NOT UPDATE or DELETE rows here.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
    ip: text('ip'),
    ua: text('ua'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_user_id_idx').on(t.userId)],
);
