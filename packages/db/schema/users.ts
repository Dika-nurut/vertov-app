import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { tierEnum, userStatusEnum } from './enums';

export const usersApp = pgTable('users_app', {
  // Stores Better Auth user.id verbatim (CUID2 / arbitrary text). Do NOT truncate.
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  tgUserId: text('tg_user_id').unique(),
  displayName: text('display_name'),
  locale: text('locale').notNull().default('ru'),
  tier: tierEnum('tier').notNull().default('free'),
  status: userStatusEnum('status').notNull().default('active'),
  // Soft-delete tombstone. Set in tandem with status='deleted' by
  // DELETE /v1/me; users_pii is hard-deleted in the same tx (152-ФЗ).
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // Worker account-erasure sweep marker. Kept on the tombstone so a bounded
  // reaper batch can make progress across many deleted accounts while still
  // retrying a prefix that failed object-store cleanup.
  erasureObjectsClearedAt: timestamp('erasure_objects_cleared_at', { withTimezone: true }),
  // Onboarding: NULL until the user submits or skips the 3-question card.
  // NOT PII — no identifiers, just preference signals. 152-ФЗ cascade covers deletion.
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  onboardingAnswers: jsonb('onboarding_answers'),
});

/**
 * RU-PII — 152-ФЗ split target.
 * Designed so we can move this table to Selectel/Yandex Cloud managed PG
 * (Moscow region) with one migration when MAU > 5k.
 *
 * Table comment is applied by the post-migrate script in scripts/migrate.ts.
 */
export const usersPii = pgTable('users_pii', {
  id: text('id')
    .primaryKey()
    .references(() => usersApp.id, { onDelete: 'cascade' }),
  email: text('email').unique(),
  phone: text('phone').unique(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
  lastPaymentMethodBrand: text('last_payment_method_brand'),
});
