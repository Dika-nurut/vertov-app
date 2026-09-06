import { index, integer, numeric, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * One row per ATTEMPT the **third leg of the image chain** (`openrouter-official` —
 * Google's own listing on OpenRouter, reached as laozhang → kie → here) was
 * authorized to submit. This is the counter behind finance's 2026-08-02 ruling
 * (Ask 8, option b): the leg is allowed as ban-wave insurance, inside a
 * 3 000 ₽/day + 20 000 ₽/rolling-month cap on accumulated negative margin.
 *
 * **A row is written BEFORE the provider call, not after it.** The first cut
 * inserted only on a successful settle, which made the cap a counter of
 * successful jobs: a fan-out whose third call failed after two were billed, a
 * response with no usable asset, an upload crash, the reaper winning the settle
 * race — every one of those spends real money and wrote nothing. Worse, the
 * pre-submit test read a historical sum with no reservation, so during the
 * outage this leg exists for, N concurrent jobs all saw the same headroom and
 * all submitted; overshoot was bounded by concurrency, not by the cap.
 *
 * So the row is a RESERVATION that later becomes a settlement:
 *  - `cost_rub` holds everything this ATTEMPT committed us to, and `pending_rub`
 *    the part of it still in flight (worst case, revenue not yet known). Both
 *    windows sum `cost_rub − revenue_rub`, so a reservation counts against the
 *    cap from the moment it is taken.
 *  - settling REPLACES the in-flight part with what the attempt really cost
 *    (`cost_rub − pending_rub + invoiced`) and adds the revenue.
 *  - releasing subtracts the in-flight part and leaves a zero-impact row, for
 *    the one case we can prove the vendor was never billed.
 * `cost_source` says which of those happened; `settled_at IS NULL` means still
 * in flight. Nothing here posts to a ledger or closes a period — finance asked
 * for a counter, not an accounting integration.
 *
 * **The row is scoped to an ATTEMPT, not to a job** (2026-08-03). A job that
 * fails retryably is submitted again, and every submit is a separate real
 * charge. While one row per job accumulated those charges into a single
 * `pending_rub`, all three of settle/invoice/release operated on the SUM: a
 * final attempt's invoice replaced every earlier attempt's cost, and a release
 * for an attempt the vendor refused subtracted the charges of the attempts that
 * had been billed. One row per attempt makes that arithmetic unavailable — there
 * is no shared figure left to overwrite.
 *
 * `UNIQUE(job_id, attempt_seq)`, so an attempt is addressable and a settle can
 * still be retried without double-counting.
 */
export const officialLegSpend = pgTable(
  'official_leg_spend',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    /** 1-based ordinal of the submit within the job. Attempts are serial: the
     *  runner claims `status='queued'` atomically, so one job never has two in
     *  flight at once. */
    attemptSeq: integer('attempt_seq').notNull().default(1),
    modelId: text('model_id').notNull(),
    /** Price-point rung the job was charged at ('4K', 'default', …). */
    rung: text('rung').notNull(),
    /** Billable units the leg was authorized for (images; the leg is image-only). */
    units: integer('units').notNull(),
    /** Everything this attempt committed us to, in ₽ — reserved and/or settled. */
    costRub: numeric('cost_rub', { precision: 14, scale: 4 }).notNull(),
    /** The part of `cost_rub` still in flight: reserved at the configured rate,
     *  awaiting the real outcome. Zero once the attempt reaches a terminal state. */
    pendingRub: numeric('pending_rub', { precision: 14, scale: 4 }).notNull().default('0'),
    /** What the customer paid: credits settled × the conservative ₽/credit floor. */
    revenueRub: numeric('revenue_rub', { precision: 14, scale: 4 }).notNull(),
    /**
     * How `cost_rub` came to be:
     *  - `reserved` — in flight, priced at `units × officialUsdPerUnit[rung]`.
     *  - `invoiced` — settled at OpenRouter's own `usage.cost` for the job.
     *  - `configured` — settled, but the response carried no cost; the reserved
     *    figure stands. (Comparing the two is how we find out whether the one
     *    rate we hold an invoice for is still the rate we are charged.)
     *  - `released` — provably never reached the vendor; contributes nothing.
     */
    costSource: text('cost_source').notNull().default('reserved'),
    /**
     * Why the configured figure stood instead of an invoice — `no_invoice`,
     * `partial_invoice` (the fan-out priced only some of its calls),
     * `other_attempt_invoiced` (the job's one invoice belongs to a different
     * attempt), `reaper_unsettled` (nothing in the runner ever closed this).
     * NULL when the row was invoiced or released. An attempt that keeps our
     * guess has to say so: otherwise `configured` cannot be told apart from
     * "the vendor happened to charge exactly what we predicted".
     */
    costNote: text('cost_note'),
    /** When the outcome became known. NULL = still in flight. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** When the leg was AUTHORIZED — the moment the money was committed, and so
     *  the timestamp both rolling windows are measured from. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('official_leg_spend_occurred_at_idx').on(t.occurredAt),
    // job_id is no longer unique, and settle/release look rows up by it.
    index('official_leg_spend_job_id_idx').on(t.jobId),
    unique('official_leg_spend_job_attempt_unique').on(t.jobId, t.attemptSeq),
  ],
);
