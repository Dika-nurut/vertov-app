import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { scripts } from './scripts';

/**
 * Editorial timing revisions for Scenario source units.
 *
 * Timing is append-only: a new user edit or Vertov suggestion supersedes the
 * previous row. Staleness is derived from the current source revision at read
 * time, so a text edit cannot silently mutate history or move a user-owned value.
 */
export const scriptSceneTimings = pgTable(
  'script_scene_timings',
  {
    id: text('id').primaryKey(),
    scriptId: text('script_id')
      .notNull()
      .references(() => scripts.id, { onDelete: 'cascade' }),
    /** Stable source-unit key for the current Scenario extraction. */
    sourceUnitId: text('source_unit_id').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    owner: text('owner').notNull(),
    /** Content revision/hash the timing was estimated or approved against. */
    sourceRevisionId: text('source_revision_id').notNull(),
    estimatorPolicyVersion: text('estimator_policy_version').notNull(),
    supersedesTimingId: text('supersedes_timing_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('script_scene_timings_script_unit_idx').on(t.scriptId, t.sourceUnitId, t.createdAt),
    index('script_scene_timings_script_created_idx').on(t.scriptId, t.createdAt),
    check(
      'script_scene_timings_duration_positive_ck',
      sql`${t.durationSeconds} > 0 AND ${t.durationSeconds} <= 7200`,
    ),
    check('script_scene_timings_owner_ck', sql`${t.owner} IN ('vertov', 'user')`),
  ],
);
