import { costLegFile } from './cost-legs-data';

/**
 * The loss budget for the **third leg of the image chain** (Google's own
 * listing on OpenRouter, reached as `laozhang → kie → openrouter-official`).
 *
 * Finance ruled on 2026-08-02 (`docs/business/finance-ask-model-cogs-2026-08-02.md`
 * Ask 8, option b): the leg stays as ban-wave insurance, but its loss is capped
 * and metered — 3 000 ₽/day and 20 000 ₽/rolling month of accumulated negative
 * margin `(cost − revenue)`. When either cap is crossed the leg stops routing
 * until a relay returns.
 *
 * This module is the **pure half** — arithmetic, window sizes, and the
 * cap-crossing decision, with no database. The persistence and the SQL windows
 * live in `./official-leg-ledger`, so this can be reasoned about (and tested)
 * without a connection.
 *
 * Deliberately a COUNTER, not an accounting integration: one row per job served
 * on the leg, two rolling sums, one boolean. No period close, no reconciliation,
 * no ledger postings.
 */

/** `app_settings` keys holding the caps. Data, not constants — finance retunes
 *  them with an UPDATE, not a deploy. */
export const OFFICIAL_LEG_DAILY_CAP_KEY = 'official_leg_budget_daily_rub';
export const OFFICIAL_LEG_MONTHLY_CAP_KEY = 'official_leg_budget_monthly_rub';

/**
 * Both windows ROLL rather than resetting on a calendar boundary. Finance wrote
 * "3 000 ₽/day, 20 000 ₽/rolling month … reset daily and monthly"; a rolling
 * 24 h window honours the daily number strictly (a calendar reset would let us
 * lose 3 000 ₽ at 23:50 and another 3 000 ₽ at 00:10), and it needs no scheduled
 * reset job — the second mechanism we were told not to build.
 *
 * Each window is the HALF-OPEN interval `(now − window, now]`: a loss that is
 * exactly `window` old has left it. "The last 24 hours" excludes the instant
 * 24 hours ago, and a half-open interval is the only convention under which a
 * loss belongs to exactly one window as time passes. The SQL says `>`, not
 * `>=`, and `__tests__` pins the exact boundary rather than a comfortable 30 h.
 */
export const OFFICIAL_LEG_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OFFICIAL_LEG_MONTH_WINDOW_MS = 30 * OFFICIAL_LEG_DAY_WINDOW_MS;

/**
 * Landed USD→RUB for the OpenRouter channel. The third leg is billed on the
 * OpenRouter invoice, so it settles at the signed workbook export's landed
 * OpenRouter rate, the same finance-frozen basis `price-breakeven.ts` scores
 * every OpenRouter route on.
 */
const openrouterFx = costLegFile.legs.find(
  (leg) => leg.relay.trim().toLowerCase() === 'openrouter',
)?.landedRubPerUnit;
if (!openrouterFx || !Number.isFinite(openrouterFx) || openrouterFx <= 0) {
  throw new Error('official-leg-budget: workbook export has no valid OpenRouter landed FX');
}
export const OFFICIAL_LEG_FX_RUB: number = openrouterFx;

export interface OfficialLegCaps {
  dailyRub: number;
  monthlyRub: number;
}

export interface OfficialLegSpendWindows {
  /** Accumulated negative margin in the trailing 24 h, floored at 0. */
  dayRub: number;
  /** Accumulated negative margin in the trailing 30 days, floored at 0. */
  monthRub: number;
}

/**
 * Read one cap out of an `app_settings` jsonb value. **Fail-closed**: anything
 * that is not a finite non-negative number is a cap of 0, which turns the leg
 * off. A missing/garbled cap must never read as "unlimited" — an unbudgeted leg
 * is the exact status quo finance rejected.
 */
export function parseCapRub(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** ₽ the leg cost us for one job. */
export function officialLegCostRub(units: number, usdPerUnit: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  return units * usdPerUnit * OFFICIAL_LEG_FX_RUB;
}

/** ₽ the customer paid for that job, at the conservative credit floor. */
export function officialLegRevenueRub(creditsSpent: number, creditRub: number): number {
  if (!Number.isFinite(creditsSpent) || creditsSpent <= 0) return 0;
  if (!Number.isFinite(creditRub) || creditRub <= 0) return 0;
  return creditsSpent * creditRub;
}

/**
 * Add a job that has not happened yet to both windows.
 *
 * The cap is a limit on money we will have lost, so the job asking for
 * permission has to be part of the sum that decides. Testing the historical sum
 * alone approves the very job that breaks the cap — and, once N of them are in
 * flight at once, N of them.
 */
export function withProspectiveLoss(
  spend: OfficialLegSpendWindows,
  prospectiveRub: number,
): OfficialLegSpendWindows {
  const add = Number.isFinite(prospectiveRub) && prospectiveRub > 0 ? prospectiveRub : 0;
  return { dayRub: spend.dayRub + add, monthRub: spend.monthRub + add };
}

/**
 * Is there headroom in BOTH windows?
 *
 * Strictly `<`, so a cap of 0 (unset, garbled, or deliberately zeroed by
 * finance) means the leg never routes. A window whose net is a PROFIT reads as
 * 0 spent, not as negative headroom — a profitable job must not buy budget for
 * a future loss (that flooring happens where the sums are read).
 *
 * Callers pass the sum INCLUDING the prospective job (see
 * {@link withProspectiveLoss}); with strict `<`, a job that would land exactly
 * on the cap is refused.
 */
export function hasOfficialLegHeadroom(
  spend: OfficialLegSpendWindows,
  caps: OfficialLegCaps,
): boolean {
  return spend.dayRub < caps.dailyRub && spend.monthRub < caps.monthlyRub;
}
