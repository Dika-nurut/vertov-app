import { inArray, sql } from 'drizzle-orm';
import { appSettings } from '../schema/free-program';
import { officialLegSpend } from '../schema/official-leg-spend';
import { db as defaultDb } from './index';
import { nid } from './id';
import { readConservativeCreditFloorRub, type DbRunner } from './credit-floor';
import {
  OFFICIAL_LEG_DAILY_CAP_KEY,
  OFFICIAL_LEG_DAY_WINDOW_MS,
  OFFICIAL_LEG_FX_RUB,
  OFFICIAL_LEG_MONTHLY_CAP_KEY,
  OFFICIAL_LEG_MONTH_WINDOW_MS,
  hasOfficialLegHeadroom,
  officialLegCostRub,
  officialLegRevenueRub,
  parseCapRub,
  withProspectiveLoss,
  type OfficialLegCaps,
  type OfficialLegSpendWindows,
} from './official-leg-budget';

/**
 * Persistence for the third leg's loss budget — the IO half of
 * `./official-leg-budget` (which holds the arithmetic and the decision).
 *
 * Three verbs, in the order a job meets them:
 * {@link reserveOfficialLegSpend} before the provider call — the pre-submit gate
 * AND the booking, in one serialized transaction; {@link settleOfficialLegSpend}
 * once the outcome is known, whatever the outcome was; {@link releaseOfficialLegSpend}
 * for the narrow case where the vendor provably never saw the request.
 *
 * There is no separate "may I?" read. A gate that only reads is a race: every
 * concurrent request sees the same headroom and every one of them submits.
 */

/**
 * Every reservation serializes on this advisory lock, so the read of the windows
 * and the write of the new row are one indivisible decision. The leg is a
 * last-resort outage path — a few requests per second at worst — so a global
 * lock costs nothing and is the only thing that makes the cap a cap.
 *
 * Transaction-scoped (`pg_advisory_xact_lock`): released by COMMIT or ROLLBACK,
 * so a crashed worker cannot wedge the leg.
 */
export const OFFICIAL_LEG_RESERVATION_LOCK = 810_220_268;

/**
 * The caps, from `app_settings` — data, so finance retunes them with an UPDATE
 * rather than a deploy. Missing or garbled reads as 0, which turns the leg off:
 * an unmetered leg is the status quo finance rejected, so "no config" must not
 * mean "no limit".
 */
export async function readOfficialLegCaps(runner: DbRunner = defaultDb): Promise<OfficialLegCaps> {
  const rows = await runner
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, [OFFICIAL_LEG_DAILY_CAP_KEY, OFFICIAL_LEG_MONTHLY_CAP_KEY]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    dailyRub: parseCapRub(byKey.get(OFFICIAL_LEG_DAILY_CAP_KEY)),
    monthlyRub: parseCapRub(byKey.get(OFFICIAL_LEG_MONTHLY_CAP_KEY)),
  };
}

/**
 * Accumulated negative margin in each rolling window — reservations included,
 * because money committed is money spent as far as a cap is concerned.
 *
 * Each window is half-open, `(now − window, now]`: the SQL is `>`, so a loss
 * exactly 24 h / 30 d old has left it (see `./official-leg-budget`).
 *
 * **Flooring is per JOB, not over the total.** Finance capped "accumulated
 * negative margin"; a job that came out ahead has no negative margin to
 * accumulate, so it contributes 0 rather than −89 ₽ of headroom for the next
 * loss. The old SQL summed net across every row and floored only the aggregate,
 * which is a cap on NET margin — and directly contradicted the comment above it.
 *
 * The job, not the row, is the unit: a retried job spreads its cost over several
 * attempt rows while the revenue lands on one of them, so flooring per row would
 * charge the cap for an attempt of a job that was profitable overall. Grouping
 * by job also keeps the cap's meaning exactly what it was before the rows were
 * split by attempt.
 */
export async function readOfficialLegSpend(
  runner: DbRunner = defaultDb,
  now: Date = new Date(),
): Promise<OfficialLegSpendWindows> {
  const dayStart = new Date(now.getTime() - OFFICIAL_LEG_DAY_WINDOW_MS);
  const monthStart = new Date(now.getTime() - OFFICIAL_LEG_MONTH_WINDOW_MS);
  // One scan of the 30-day window; the day figure is a FILTERed aggregate over
  // the same rows rather than a second query. A job with no attempt inside the
  // day window has a NULL day net, which `sum` skips.
  const result = await runner.execute(sql`
    SELECT coalesce(sum(greatest(per_job.day_net, 0)), 0) AS day,
           coalesce(sum(greatest(per_job.month_net, 0)), 0) AS month
    FROM (
      SELECT sum(cost_rub - revenue_rub) FILTER (WHERE occurred_at > ${dayStart}) AS day_net,
             sum(cost_rub - revenue_rub) AS month_net
      FROM official_leg_spend
      WHERE occurred_at > ${monthStart}
      GROUP BY job_id
    ) AS per_job
  `);
  const row = result.rows[0] as { day: string; month: string } | undefined;
  return { dayRub: Number(row?.day ?? 0), monthRub: Number(row?.month ?? 0) };
}

export interface OfficialLegReservation {
  jobId: string;
  modelId: string;
  /** Price-point rung the request lands on — what it is charged at, and costed at. */
  rung: string;
  /** Billable units the leg is about to submit (the leg is image-only). */
  units: number;
  /** Third-leg USD per unit for this rung — never inferred, see `@seed/shared/official-leg-cost`. */
  usdPerUnit: number;
}

export type OfficialLegReservationResult =
  | {
      reserved: true;
      reservedRub: number;
      /** The attempt row this booking created. The ONLY thing a release may
       *  name — see {@link releaseOfficialLegSpend}. */
      attemptId: string;
    }
  | {
      reserved: false;
      /**
       * `no-credit-floor` — the catalogue prices no credit, so every job on this
       * leg is a 100% loss and none may go out.
       * `budget-exhausted` — this job's own worst case does not fit under a cap.
       */
      reason: 'no-credit-floor' | 'budget-exhausted';
      prospectiveRub: number;
      spend: OfficialLegSpendWindows;
      caps: OfficialLegCaps;
    };

/**
 * Book this job's worst case against the budget, and answer whether it may go
 * out. **This is the gate** — it decides and reserves in one transaction, under
 * an advisory lock, so two concurrent requests cannot both be told yes on the
 * same headroom.
 *
 * The reservation is priced at the FULL vendor cost with revenue 0. Revenue is
 * not knowable here (the credits a job settles at depend on what it delivers),
 * and a guard whose job is to stop spending must round against itself: the cap
 * therefore bites slightly early while jobs are in flight, and each settlement
 * corrects the row down to the true net.
 *
 * A retry of the same job books its OWN row. A second submit is a second real
 * charge; giving it a separate row is what stops a later invoice or release from
 * reaching back and rewriting it (see the schema comment). `attempt_seq` is
 * allocated under the same advisory lock the cap decision takes, so it is a
 * plain `max + 1` with no race in it.
 */
export async function reserveOfficialLegSpend(
  reservation: OfficialLegReservation,
  runner: typeof defaultDb = defaultDb,
  now: Date = new Date(),
): Promise<OfficialLegReservationResult> {
  const prospectiveRub = officialLegCostRub(reservation.units, reservation.usdPerUnit);
  return runner.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${OFFICIAL_LEG_RESERVATION_LOCK})`);
    const caps = await readOfficialLegCaps(tx);
    const spend = await readOfficialLegSpend(tx, now);

    // Fail-closed on a catalogue that prices no credit. Revenue would settle at
    // 0 either way, but the refusal has to happen HERE: discovering it after the
    // provider was paid is the same blindness the reservation exists to remove.
    const creditRub = await readConservativeCreditFloorRub(tx);
    if (!(creditRub > 0)) {
      return { reserved: false, reason: 'no-credit-floor', prospectiveRub, spend, caps };
    }

    if (!hasOfficialLegHeadroom(withProspectiveLoss(spend, prospectiveRub), caps)) {
      return { reserved: false, reason: 'budget-exhausted', prospectiveRub, spend, caps };
    }

    const amount = prospectiveRub.toFixed(4);
    const attemptId = nid();
    await tx.insert(officialLegSpend).values({
      id: attemptId,
      jobId: reservation.jobId,
      attemptSeq: sql`(SELECT coalesce(max(attempt_seq), 0) + 1 FROM official_leg_spend WHERE job_id = ${reservation.jobId})`,
      modelId: reservation.modelId,
      rung: reservation.rung,
      units: reservation.units,
      costRub: amount,
      pendingRub: amount,
      revenueRub: '0.0000',
      costSource: 'reserved',
      occurredAt: now,
    });
    return { reserved: true, reservedRub: prospectiveRub, attemptId };
  });
}

export interface OfficialLegSettlement {
  jobId: string;
  /**
   * Credits the customer was actually charged. **0 for every outcome that
   * refunded them** — a failed job, a reaper-cancelled one — which is exactly
   * when the leg's loss is largest and used to be recorded as nothing at all.
   */
  creditsSpent: number;
  /**
   * OpenRouter's own `usage.cost` in USD, when the outcome carried one that is
   * COMPLETE for every unit the attempt reserved. It is the INVOICE; the
   * reserved figure is our configured guess. A partial figure must arrive here
   * as `null` with a `costNote` — see `officialLegInvoiceOf` in the worker.
   */
  providerCostUsd?: number | null;
  /** Why there is no invoice, recorded on the rows that keep our guess. */
  costNote?: string | null;
}

export type OfficialLegSettleResult =
  | { settled: false }
  | {
      settled: true;
      /** Final ₽ every attempt of this job cost us, added up. */
      costRub: number;
      /** What was reserved for the attempt the invoice was applied to (or for
       *  all of them when there was no invoice), for comparison. */
      configuredRub: number;
      revenueRub: number;
      /** How many attempt rows this settlement closed. */
      attempts: number;
      source: 'invoiced' | 'configured';
    };

/**
 * Close out every open reservation of a job, whatever happened to it.
 *
 * There is no "did this job use the leg?" test here, and that is deliberate: the
 * question is answered by whether a reservation EXISTS, keyed on the job id. The
 * previous design keyed on the `gateway_used` string, which a chain that
 * collapsed to a single leg never stamped — so the money path no longer depends
 * on a tag being right. No reservation, no row, no-op.
 *
 * ## Where the invoice lands
 *
 * At most ONE attempt is invoiced, and it is the LATEST open one. A job's
 * attempts are serial — the runner claims `status='queued'` atomically, so a job
 * never has two submits in flight — and the result carrying `usage.cost` came
 * from the submit that just returned, which is that latest attempt. Every other
 * open attempt failed without an invoice and keeps its configured cost, marked
 * `other_attempt_invoiced`. That is the fix for "one invoice erases every
 * earlier retry's cost": the arithmetic can no longer see another attempt's ₽.
 *
 * The caller must have already established that the invoice belongs to THIS leg
 * (`meta.servedBy`) and covers the whole attempt; an unverifiable figure arrives
 * as `null` and the reservation stands.
 *
 * ## Why the lock
 *
 * An invoice larger than the reservation RAISES a total the cap is computed
 * from. Reservations serialize on `OFFICIAL_LEG_RESERVATION_LOCK`; a settlement
 * that skipped it let a concurrent reservation read a pre-invoice snapshot and
 * be approved over the cap. Only a cost-INCREASING settlement takes the lock, so
 * the overwhelmingly common case (no invoice, or no leg row at all) never
 * serializes job completion globally.
 *
 * Idempotent: a retried settle finds no open row and does nothing.
 */
export async function settleOfficialLegSpend(
  settlement: OfficialLegSettlement,
  runner: DbRunner = defaultDb,
): Promise<OfficialLegSettleResult> {
  const invoicedUsd = settlement.providerCostUsd;
  const invoicedRub =
    typeof invoicedUsd === 'number' && Number.isFinite(invoicedUsd) && invoicedUsd > 0
      ? invoicedUsd * OFFICIAL_LEG_FX_RUB
      : null;
  if (invoicedRub !== null) {
    await runner.execute(sql`SELECT pg_advisory_xact_lock(${OFFICIAL_LEG_RESERVATION_LOCK})`);
  }
  const creditRub = await readConservativeCreditFloorRub(runner);
  const revenueRub = officialLegRevenueRub(settlement.creditsSpent, creditRub);
  const note = settlement.costNote ?? 'no_invoice';
  // One statement, so a caller without an ambient transaction still settles all
  // of a job's attempts atomically. `reserved` also carries the pre-update
  // pending_rub back, so the caller can compare our rate against the invoice
  // without a second read.
  const result = await runner.execute(sql`
    WITH reserved AS (
      SELECT id, attempt_seq, pending_rub
      FROM official_leg_spend
      WHERE job_id = ${settlement.jobId} AND settled_at IS NULL
      FOR UPDATE
    ),
    last_attempt AS (SELECT max(attempt_seq) AS seq FROM reserved)
    UPDATE official_leg_spend AS spend
    SET cost_rub = ${
      invoicedRub === null
        ? sql`spend.cost_rub`
        : sql`CASE WHEN reserved.attempt_seq = last_attempt.seq
                   THEN spend.cost_rub - reserved.pending_rub + ${invoicedRub.toFixed(4)}::numeric
                   ELSE spend.cost_rub END`
    },
        revenue_rub = spend.revenue_rub + CASE WHEN reserved.attempt_seq = last_attempt.seq
                        THEN ${revenueRub.toFixed(4)}::numeric ELSE 0 END,
        pending_rub = 0,
        settled_at = now(),
        cost_source = ${
          invoicedRub === null
            ? sql`'configured'`
            : sql`CASE WHEN reserved.attempt_seq = last_attempt.seq THEN 'invoiced' ELSE 'configured' END`
        },
        cost_note = ${
          invoicedRub === null
            ? sql`${note}`
            : sql`CASE WHEN reserved.attempt_seq = last_attempt.seq THEN NULL ELSE 'other_attempt_invoiced' END`
        }
    FROM reserved, last_attempt
    WHERE spend.id = reserved.id
    RETURNING spend.cost_rub AS cost_rub,
              spend.revenue_rub AS revenue_rub,
              spend.cost_source AS cost_source,
              reserved.pending_rub AS configured_rub
  `);
  const rows = result.rows as Array<{
    cost_rub: string;
    revenue_rub: string;
    cost_source: string;
    configured_rub: string;
  }>;
  if (rows.length === 0) return { settled: false };
  const invoiced = rows.find((row) => row.cost_source === 'invoiced');
  return {
    settled: true,
    costRub: rows.reduce((total, row) => total + Number(row.cost_rub), 0),
    configuredRub: invoiced
      ? Number(invoiced.configured_rub)
      : rows.reduce((total, row) => total + Number(row.configured_rub), 0),
    revenueRub: rows.reduce((total, row) => total + Number(row.revenue_rub), 0),
    attempts: rows.length,
    source: invoiced ? 'invoiced' : 'configured',
  };
}

/**
 * Give ONE attempt's reservation back — for the case we can PROVE the vendor
 * never billed it (see `official-fallback-adapter.ts`: a single-call request the
 * vendor refused outright). The row stays for forensics with a net impact of 0.
 *
 * **Takes the attempt id the reservation returned, not a job id.** A job whose
 * attempt 1 was billed and whose attempt 2 was refused must keep attempt 1's ₽;
 * while release worked per job it subtracted the accumulated pending of every
 * attempt and marked the job settled, so the real charge vanished and the
 * terminal settle then no-opped. Naming the attempt makes that arithmetic
 * unavailable rather than merely unlikely.
 *
 * Deliberately narrow. A rejection is not generally proof that nothing was
 * spent: the image path fans out N parallel calls and rejects on the first
 * failure while its siblings are billed regardless. Releasing on any error would
 * re-create the hole this work closes — but never releasing has its own failure
 * mode, and a loud one: a wrong API key 401s every request, and 3 000 ₽ of
 * budget would be burned by requests that cost nothing, taking the leg offline
 * for a day during the outage it exists for.
 */
export async function releaseOfficialLegSpend(
  attemptId: string,
  runner: DbRunner = defaultDb,
): Promise<boolean> {
  const result = await runner.execute(sql`
    UPDATE official_leg_spend
    SET cost_rub = cost_rub - pending_rub,
        pending_rub = 0,
        settled_at = now(),
        cost_source = 'released',
        cost_note = NULL
    WHERE id = ${attemptId} AND settled_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * Close every reservation whose job is already in a terminal state — the
 * backstop that makes terminal settlement DURABLE.
 *
 * Settlement runs inside the transaction that ends the job, so it commits or
 * rolls back with it. What has no retry is the case where that transaction
 * never lands at all: the worker is killed between the submit and the settle, or
 * the settling transaction fails and the redelivered `runJob` finds a job that
 * is no longer `queued` and skips it. The reservation then holds its worst case
 * against the cap until it ages out of the 30-day window.
 *
 * The reaper calls this every tick, so it retries until it succeeds. A job that
 * is still `queued` (waiting for a retry) or `running` (a live submit) is left
 * alone — its attempt is being accounted for by someone. An open reservation on
 * a job that has FINISHED can only mean nobody settled it: a succeeded job
 * settles in the same transaction that marks it succeeded, so if that row says
 * succeeded, its reservation is closed.
 *
 * Everything it closes is priced at the reservation (our conservative worst
 * case) with zero revenue, which is also the honest reading: nothing here
 * reached the point of knowing what was delivered.
 */
export async function sweepUnsettledOfficialLegSpend(
  runner: DbRunner = defaultDb,
): Promise<number> {
  const result = await runner.execute(sql`
    UPDATE official_leg_spend AS spend
    SET pending_rub = 0,
        settled_at = now(),
        cost_source = 'configured',
        cost_note = 'reaper_unsettled'
    FROM jobs
    WHERE jobs.id = spend.job_id
      AND spend.settled_at IS NULL
      AND jobs.status NOT IN ('queued', 'running')
    RETURNING spend.id
  `);
  return result.rows.length;
}
