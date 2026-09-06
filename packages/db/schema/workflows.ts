import { AnyPgColumn, boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { models } from './models';
import { usersApp } from './users';

/**
 * Workflows are the reproducible spec for any generation: model + params + references.
 * Persisted on EVERY generate call — the canonical source for "do it again" / remix.
 */
export const workflows = pgTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'restrict' }),
    params: jsonb('params').notNull().$type<Record<string, unknown>>().default({}),
    referenceAssets: jsonb('reference_assets').notNull().$type<string[]>().default([]),
    name: text('name'),
    isPublic: boolean('is_public').notNull().default(false),
    parentWorkflowId: text('parent_workflow_id').references((): AnyPgColumn => workflows.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workflows_user_id_idx').on(t.userId),
    index('workflows_model_id_idx').on(t.modelId),
    index('workflows_parent_id_idx').on(t.parentWorkflowId),
  ],
);
