import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Sibling forensic journal for every routed provider submit. This is
 * deliberately separate from `official_leg_spend`: that table is queried by
 * two cap paths without a gateway predicate, so adding generic rows there
 * would make a Kie/OpenRouter invoice settle an official row and inflate (or
 * understate) finance's cap during a rolling deploy.
 */
export const routeAttemptJournal = pgTable(
  'route_attempt_journal',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    attemptSeq: integer('attempt_seq').notNull().default(1),
    modelId: text('model_id').notNull(),
    rung: text('rung').notNull().default('unknown'),
    role: text('role').notNull().default('primary'),
    legIdentity: text('leg_identity').notNull(),
    gateway: text('gateway').notNull(),
    outcome: text('outcome').notNull().default('intent'),
    ambiguous: boolean('ambiguous').notNull().default(false),
    providerJobId: text('provider_job_id'),
    units: numeric('units', { precision: 14, scale: 4 }),
    configuredExpectedCostRub: numeric('configured_expected_cost_rub', {
      precision: 14,
      scale: 4,
    }),
    vendorReportedCostRub: numeric('vendor_reported_cost_rub', { precision: 14, scale: 4 }),
    revenueRub: numeric('revenue_rub', { precision: 14, scale: 4 }),
    costSource: text('cost_source').notNull().default('configured'),
    costNote: text('cost_note'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    unique('route_attempt_journal_job_attempt_unique').on(t.jobId, t.attemptSeq),
    index('route_attempt_journal_job_idx').on(t.jobId),
    index('route_attempt_journal_job_provider_idx').on(t.jobId, t.providerJobId),
    index('route_attempt_journal_leg_rung_submitted_idx').on(t.legIdentity, t.rung, t.submittedAt),
    // The margin alarm's window read has no leg or rung predicate, so the composite
    // index above cannot serve it — its leading columns stay unconstrained.
    index('route_attempt_journal_submitted_idx').on(t.submittedAt),
  ],
);
