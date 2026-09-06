import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersApp } from './users';

/**
 * Free-token welcome program (Phase 1). Progressive-trust L0–L3 grants plus the
 * anti-farm cluster machinery. See packages/credits/src/welcome.ts for the grant
 * engine and the exact idempotency-key / clawback semantics.
 */

/**
 * Runtime feature flags / kill-switches, key→value. Read at grant time and
 * toggled via the admin PATCH route — a DB row (not an env var) so an operator
 * can flip the free-grants kill-switch without a redeploy. `value` is jsonb so a
 * flag can hold a bool, number, or small object without a schema change.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  // Acting admin userId for the last write (audit); NULL for a system/default write.
  updatedBy: text('updated_by'),
});

/**
 * Anti-farm cluster. Identity = hash(deviceId cookie + /24 subnet). We store ONLY
 * the derived hash — never the raw device id or IP — for the 152-ФЗ posture (no
 * fingerprinting). `tokensGranted` is the lifetime running total for reference /
 * telemetry; the authoritative rolling-30d cap is computed from free_grant_events.
 */
export const freeClusters = pgTable('free_clusters', {
  clusterKey: text('cluster_key').primaryKey(),
  tokensGranted: integer('tokens_granted').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Server-observed registration velocity windows. `scope` is either a salted
 * /24 key or the global bucket; no raw IP is retained.
 */
export const freeRegistrationWindows = pgTable('free_registration_windows', {
  scope: text('scope').primaryKey(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  registrations: integer('registrations').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * One row per welcome grant actually issued. Triple duty: per-grant audit, the
 * rolling-cap counter source (L0/L1 plus DAILY:% levels over 30d), and the
 * telemetry history Phase 3 reconciliation reads. The
 * (user_id, level) unique index makes a double-grant of the same level
 * structurally impossible even under a concurrent-request race.
 */
export const freeGrantEvents = pgTable(
  'free_grant_events',
  {
    id: text('id').primaryKey(),
    clusterKey: text('cluster_key')
      .notNull()
      .references(() => freeClusters.clusterKey),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    // 'L0' | 'L1' | 'L2' | 'L3'.
    level: text('level').notNull(),
    amount: integer('amount').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('free_grant_events_user_level_uq').on(t.userId, t.level),
    index('free_grant_events_cluster_created_idx').on(t.clusterKey, t.createdAt),
    index('free_grant_events_created_level_idx').on(t.createdAt, t.level),
  ],
);

/**
 * Phone anchor: one phone hash (sha256 of the normalized E.164 number) anchors
 * exactly one account's bonuses. PK on phone_hash enforces the "one phone = one
 * account" rule structurally. NO raw phone stored (152-ФЗ). Cascade-deletes with
 * the user so a deleted account frees the anchor.
 */
export const freePhoneAnchors = pgTable('free_phone_anchors', {
  phoneHash: text('phone_hash').primaryKey(),
  clusterKey: text('cluster_key')
    .notNull()
    .references(() => freeClusters.clusterKey),
  userId: text('user_id')
    .notNull()
    .references(() => usersApp.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
