import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  doublePrecision,
  boolean,
} from 'drizzle-orm/pg-core';
import { usersApp } from './users';
import { scriptAssistRequests, scripts } from './scripts';

/**
 * One row per gateway call. This table will need a retention sweep as it grows.
 * error_message may contain provider-echoed request text and is erased with the account via user_id CASCADE.
 */
export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    userId: text('user_id').references(() => usersApp.id, { onDelete: 'cascade' }),
    op: text('op').notNull(),
    route: text('route').notNull(),
    model: text('model').notNull(),
    attempt: integer('attempt').notNull().default(1),
    outcome: text('outcome').notNull(),
    claimId: text('claim_id').references(() => scriptAssistRequests.id, { onDelete: 'set null' }),
    scriptId: text('script_id').references(() => scripts.id, { onDelete: 'set null' }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    usageReported: boolean('usage_reported').notNull(),
    costUsd: doublePrecision('cost_usd'),
    costSource: text('cost_source'),
    creditsCharged: integer('credits_charged'),
    cacheMarkersSent: boolean('cache_markers_sent').notNull().default(false),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('ai_usage_events_created_at_idx').on(t.createdAt),
    index('ai_usage_events_op_created_at_idx').on(t.op, t.createdAt),
    index('ai_usage_events_route_created_at_idx').on(t.route, t.createdAt),
    index('ai_usage_events_claim_id_idx').on(t.claimId),
  ],
);
