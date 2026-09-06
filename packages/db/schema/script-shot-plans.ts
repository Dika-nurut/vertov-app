import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { scripts } from './scripts';

/**
 * Durable Scenario shot-plan cache. One row is the normalized plan for an exact
 * scene source revision and approved target duration. Provider calls never fan
 * out from this table: an identical key is a zero-call replay.
 */
export const scriptShotPlans = pgTable(
  'script_shot_plans',
  {
    id: text('id').primaryKey(),
    scriptId: text('script_id')
      .notNull()
      .references(() => scripts.id, { onDelete: 'cascade' }),
    sourceSceneId: text('source_scene_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    targetDurationSeconds: integer('target_duration_seconds').notNull(),
    policyVersion: text('policy_version').notNull(),
    modelId: text('model_id').notNull(),
    plan: jsonb('plan').notNull().$type<Record<string, unknown>>(),
    creditsSpent: integer('credits_spent').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('script_shot_plans_cache_uidx').on(
      t.scriptId,
      t.sourceSceneId,
      t.sourceHash,
      t.targetDurationSeconds,
    ),
    index('script_shot_plans_script_scene_idx').on(t.scriptId, t.sourceSceneId, t.createdAt),
  ],
);

export type ScriptShotPlan = typeof scriptShotPlans.$inferSelect;
