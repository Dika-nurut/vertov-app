import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * 152-ФЗ consent ledger (audit M8). Server-side, durable proof that a user gave
 * informed, affirmative consent to a specific document version — captured at the
 * moment of consent, not inferred from a client-side checkbox.
 *
 * Deliberately NOT cascade-deleted with the account: the operator must be able to
 * prove consent existed even after the account is erased. Holds no PII beyond the
 * account id + capture ip/ua, which are the evidentiary fields.
 */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: text('id').primaryKey(),
    // The stable account id (Better Auth / usersApp.id). No FK, so the record
    // survives erasure as legal evidence.
    userId: text('user_id').notNull(),
    // Which legal document was agreed to and its version, e.g.
    // ('offer','2026-06-01'), ('aup',…), ('pdn',… — персональные данные).
    documentSlug: text('document_slug').notNull(),
    documentVersion: text('document_version').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    ua: text('ua'),
  },
  (t) => [index('consent_records_user_id_idx').on(t.userId)],
);
