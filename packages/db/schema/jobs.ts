import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { jobStatusEnum } from './enums';
import { models } from './models';
import { projects } from './projects';
import { usersApp } from './users';
import { workflows } from './workflows';

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'restrict' }),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'restrict' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    status: jobStatusEnum('status').notNull().default('queued'),
    providerJobId: text('provider_job_id'),
    // Which gateway LEG actually served this job. `gatewayUsed` is the leaf
    // vendor (never a chain alias like 'nanobanana'); `fallbackDepth` is how many
    // failover hops that leg is from the primary — 0 primary, 1 the leg priced by
    // capabilities.fallbackUsdPerUnit, >=2 a leg with no recorded cost, NULL
    // unknown (legacy rows). The admin cost report prices a job off this pair, so
    // a wrong value silently misreports margin. See migration 0065.
    gatewayUsed: text('gateway_used'),
    usedFallback: boolean('used_fallback').notNull().default(false),
    fallbackDepth: integer('fallback_depth'),
    resultAssets: jsonb('result_assets').notNull().$type<string[]>().default([]),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    // Provenance for the share-page «Повторить стиль» deep-link; nullable — plain jobs have no preset.
    presetSlug: text('preset_slug'),
    creditsReserved: integer('credits_reserved').notNull().default(0),
    creditsSpent: integer('credits_spent').notNull().default(0),
    // Resolved effective per-image credit rate at charge time, so the worker
    // settles image jobs at the SAME rate the API charged (estimate==charge==
    // settlement). It includes any per-item reference add-on; NULL means a
    // legacy image job without a settlement lock. Video ignores this (it settles
    // the full reserved amount when any asset comes back).
    creditUnitCost: integer('credit_unit_cost'),
    // Immutable model/routing/request facts captured before queueing. Nullable
    // for legacy rows; new API-created paid jobs always populate it.
    executionSnapshot: jsonb('execution_snapshot').$type<Record<string, unknown> | null>(),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    // When the job LAST re-entered the queue after a retryable failure. `queued_at` is
    // the row's creation time and is read as such — it orders «Твои генерации» and
    // groups the admin's daily analytics — so it must not be rewritten on a retry.
    // Without this column the queue reaper measured a retry's wait from the original
    // submission and refunded jobs whose BullMQ retry was still in flight.
    requeuedAt: timestamp('requeued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // Finance rev. 20 §2 — the delivered rank, measured rather than assumed.
    // `deliveredPixels` is the delivered frame's AREA; `deliveredRankStatus` is the
    // verdict from `judgeDeliveredRank` ('ok' | 'downgraded' | 'unknown'). Area, not
    // dimensions: kie's 720p on a frame-conditioned job is a pixel BUDGET fitted to the
    // input frame, so a dimension check calls a correct delivery a downgrade.
    deliveredPixels: integer('delivered_pixels'),
    deliveredRankStatus: text('delivered_rank_status'),
    // The rung as SOLD, frozen at settle time — a model's declared ladder can be edited
    // between a job's enqueue and its run, so this is not recoverable afterwards.
    deliveredRankSold: text('delivered_rank_sold'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
  },
  (t) => [
    index('jobs_user_id_idx').on(t.userId),
    index('jobs_workflow_id_idx').on(t.workflowId),
    index('jobs_model_id_idx').on(t.modelId),
    index('jobs_project_id_idx').on(t.projectId),
    index('jobs_status_idx').on(t.status),
  ],
);
