import type { Logger } from 'pino';
import {
  releaseOfficialLegSpend,
  reserveOfficialLegSpend,
  settleOfficialLegSpend,
  type DbRunner,
  type OfficialLegSettleResult,
} from '@seed/db';
import { setOfficialLegBudget } from '@seed/provider-byteplus';
import { OFFICIAL_LEG_GATEWAY } from '@seed/shared/official-leg-cost';
import { driftExceedsThreshold } from './route-margin-alarm';

/**
 * Wiring for the third leg's loss budget (finance ruling 2026-08-02, Ask 8 b —
 * 3 000 ₽/day, 20 000 ₽/rolling month of accumulated negative margin on
 * `openrouter-official`).
 *
 * {@link registerOfficialLegBudget} installs the counter into the provider
 * package's fail-closed port. The worker is the only process that builds
 * generation adapters, so this is the only place it needs installing — and while
 * it is NOT installed the chain has no third leg at all.
 *
 * The other half of the seam is {@link settleOfficialLegJob}, which the job
 * runner calls on EVERY terminal outcome. There is no "was this the official
 * leg?" test any more: the leg books a reservation keyed on the job id before it
 * submits, so the question is answered by whether that reservation exists. The
 * old design asked whether `jobs.gateway_used` equalled a magic string — which a
 * collapsed single-leg chain never wrote, and which was in any case consulted
 * only on the one outcome (a clean success) where the leg loses least.
 */

export function registerOfficialLegBudget(): void {
  setOfficialLegBudget({
    reserve: async (request) => {
      const result = await reserveOfficialLegSpend(request);
      return result.reserved
        ? { reserved: true, attemptId: result.attemptId }
        : { reserved: false, reason: result.reason };
    },
    release: async (attemptId) => {
      await releaseOfficialLegSpend(attemptId);
    },
  });
}

export interface FinishedLegJob {
  jobId: string;
  /** Credits the customer actually kept paying. 0 when they were refunded. */
  creditsSpent: number;
  /** OpenRouter's own `usage.cost` for the job, when the result carried a
   *  COMPLETE one from this leg — see {@link officialLegInvoiceOf}. */
  providerCostUsd?: number | null;
  /** Why the reserved figure stands, when it does. */
  costNote?: string | null;
}

/**
 * The invoice this outcome may be settled at, or the reason there is none.
 *
 * Two things have to be true before `usage.cost` may REPLACE a reservation, and
 * neither used to be checked:
 *
 *  - **It came from this leg.** A job that reserved on the official leg and then
 *    succeeded on a recovered relay carries whatever cost meta that relay
 *    stamped; applying it to the official row would price one vendor's work at
 *    another's bill. `servedBy` is stamped by `ServingLegAdapter` on every leg,
 *    including the collapsed single-leg chain a ban wave produces.
 *  - **It covers the whole attempt.** The image path fans out one paid call per
 *    image and used to sum a missing cost as 0, so a bill for 1 of 4 images
 *    replaced a four-image reservation. `providerCostComplete` is the adapter
 *    asserting the sum is the whole bill; its ABSENCE means no.
 */
export function officialLegInvoiceOf(meta: Record<string, unknown> | undefined): {
  providerCostUsd: number | null;
  costNote: string | null;
} {
  const cost = meta?.['providerCostUsd'];
  const usable = typeof cost === 'number' && Number.isFinite(cost) && cost > 0;
  if (meta?.['servedBy'] !== OFFICIAL_LEG_GATEWAY || !usable) {
    return { providerCostUsd: null, costNote: 'no_invoice' };
  }
  if (meta['providerCostComplete'] !== true) {
    return { providerCostUsd: null, costNote: 'partial_invoice' };
  }
  return { providerCostUsd: cost, costNote: null };
}

/**
 * How far the invoice may sit from our configured rate before we say so. The
 * rate in `capabilities.officialUsdPerUnit` comes from ONE observed invoice
 * (gemini-3-pro-image @4K, $0.241344); nothing re-checks it, and Google reprices
 * its own listing without telling us. A quiet 3x would spend the budget three
 * times faster than every reservation predicted.
 */
/**
 * Close out every open reservation of a finished job, whatever finished it.
 *
 * A no-op for every job that never touched the leg — most of them. For one that
 * did, this is where the worst case booked at submit time is replaced by what
 * actually happened: the invoice when OpenRouter sent a whole one, and the
 * revenue the customer really paid (zero on every refunded outcome).
 *
 * **Always called inside the transaction that ends the job**, so the ₽ we count
 * and the credits we settled cannot disagree — and so a settlement that fails
 * takes the job's terminal update down with it rather than leaving a job
 * finished with money in limbo. The backstop for a transaction that never lands
 * at all is `sweepUnsettledOfficialLegSpend`, which the reaper runs each tick.
 */
export async function settleOfficialLegJob(
  job: FinishedLegJob,
  runner: DbRunner,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<OfficialLegSettleResult> {
  const result = await settleOfficialLegSpend(
    {
      jobId: job.jobId,
      creditsSpent: job.creditsSpent,
      ...(job.providerCostUsd != null ? { providerCostUsd: job.providerCostUsd } : {}),
      ...(job.costNote != null ? { costNote: job.costNote } : {}),
    },
    runner,
  );
  if (!result.settled) return result;
  log.info(
    {
      jobId: job.jobId,
      costRub: result.costRub,
      revenueRub: result.revenueRub,
      attempts: result.attempts,
      source: result.source,
    },
    'official OpenRouter leg settled against its loss budget',
  );
  if (
    result.source === 'invoiced' &&
    result.configuredRub > 0 &&
    driftExceedsThreshold(result.costRub, result.configuredRub)
  ) {
    log.warn(
      { jobId: job.jobId, invoicedRub: result.costRub, configuredRub: result.configuredRub },
      'official OpenRouter leg was invoiced materially more or less than capabilities.officialUsdPerUnit predicted — re-check the rate',
    );
  }
  return result;
}
