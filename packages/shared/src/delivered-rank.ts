/**
 * Did the vendor deliver the rung the customer paid for?
 *
 * Finance's rev. 20 §2 ruling: the delivered rank governs the charge, the difference is
 * refunded automatically, an alert fires anyway so the refund cannot become a comfortable
 * equilibrium, and a rung that under-delivers more than 5% of the time over a rolling
 * week comes off sale. This module is the measurement half — the part every branch of
 * that ruling needs first.
 *
 * **The comparison is by PIXEL AREA, never by dimensions.** That is not a stylistic
 * choice; it is the result of the paid probe on 2026-08-11
 * (`docs/platform/ai-api-probe-ledger.md`). kie was asked for 720p on a frame-conditioned
 * Wan job and delivered 1108×830: the input frame's aspect (1.3333 → 1.3349) at 919 640
 * pixels, 0,2% off the nominal 1280×720. Its `720p` is a pixel BUDGET fitted to the
 * frame, and that is correct behaviour for image-to-video — our own contract sends no
 * aspect on that route precisely because the frame decides the shape.
 *
 * A check on height, or on dimensions, would have called that a downgrade. It would then
 * have refunded money we correctly earned on **every** i2v job and, at 100% "downgrade
 * rate", pulled the rung off sale within a week. A wrong rule here is more expensive than
 * no rule at all.
 */

/**
 * Nominal pixel budget per rung — **the video ladder only, and deliberately so.**
 *
 * On the video ladder the rung name IS a standard: 720p means 720 lines, every vendor
 * agrees, and we have a measured anchor (the paid kie probe below). On the IMAGE ladder
 * it is not. `1K`/`2K`/`3K`/`4K`/`8K` are marketing names whose pixel meaning is set by
 * each vendor: flux's 2K is 1536² (2,36 MP — finance's own `площадь_МП` column), while
 * seedream-5-lite and gemini-3-pro-image both declare `maxResolution: '4096x4096'`, so
 * their 4K is a 4096-class frame, not 3840×2160. And an image rung rendered at 21:9 may
 * cap a DIMENSION rather than preserve the area, which moves the count again.
 *
 * A single global table would therefore have judged a correct gemini 4K delivery against
 * a budget 2× too small in one direction and 2× too large in the other. Guessing which
 * costs a refund we do not owe on every job of that rung — the same class of error as
 * inventing a vendor rate. So image rungs answer `unknown` until each one is MEASURED,
 * which is precisely what `jobs.delivered_pixels` is now accumulating: after a week of
 * traffic the distribution per (model, rung) gives the real budgets, and they can be
 * added here as facts rather than as assumptions.
 *
 * Checked against the live catalog on 2026-08-11: no video model declares a `K` rung
 * (the ladders top out at 1080p) and no image model declares a `p` rung, so the two
 * namespaces do not collide.
 */
const RUNG_BUDGET: Readonly<Record<string, { area: number; shortSide: number }>> = {
  '480p': { area: 854 * 480, shortSide: 480 },
  '720p': { area: 1280 * 720, shortSide: 720 },
  '1080p': { area: 1920 * 1080, shortSide: 1080 },
};

/**
 * The largest area we will believe. `jobs.delivered_pixels` is `integer` (int4), so an
 * area past 2^31-1 makes the settle UPDATE throw — which fails an already-PAID job and
 * refunds it in full. A 50 000x50 000 header from a malformed container is enough to do
 * it. Anything past this is treated as unmeasurable, not as a giant delivery.
 */
const MAX_BELIEVABLE_AREA = 2_147_483_647;

/**
 * Rungs that are NOT a size, or whose size we have not measured, and must never be
 * area-checked.
 *
 * `low`/`medium`/`high` are OpenAI quality tiers on gpt-image-2 — a different axis, and
 * one where the vendor's spec exposes no size control. `default` is what
 * `priceResolutionForRequest` returns when a model declares no ladder at all. The `K`
 * rungs are here for the reason above: unmeasured, not unjudgeable in principle.
 *
 * Listing them explicitly rather than letting them fall through the table keeps the
 * `unknown` REASON honest — "not measured yet" and "no such rung" are different bugs.
 */
const NON_SIZE_RUNGS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'default']);
const UNMEASURED_RUNGS: ReadonlySet<string> = new Set(['1K', '2K', '3K', '4K', '8K']);

/**
 * How far below budget still counts as delivered.
 *
 * Vendors round to macroblock multiples and fit a budget to an arbitrary input aspect —
 * the observed error on the paid probe is 0,2%. Every real rung step is at least 2,25×
 * (480p→720p→1080p), so a 10% tolerance separates "rounded" from "downgraded" by more
 * than an order of magnitude. Deliberately generous: a false downgrade costs a refund we
 * did not owe and a withdrawal we did not need, while a missed one costs the tolerance.
 */
export const DELIVERED_AREA_TOLERANCE = 0.9;

/**
 * How far below the rung's nominal short side still counts as delivered.
 *
 * Much tighter than the area tolerance, and for a different reason. The area budget has
 * to absorb an arbitrary aspect fitted to an input frame, which is a real and large
 * effect. The short side absorbs only encoder rounding — vendors round to macroblock
 * multiples, so 720 becomes 704, a 2,2% shortfall. Reusing the area's 10% here would
 * accept 648x648 as a 720p delivery at 46% of the pixels: a genuine downgrade escaping
 * through the tolerance meant for rounding.
 */
export const DELIVERED_SHORT_SIDE_TOLERANCE = 0.97;

export type DeliveredRankVerdict =
  /** Delivered at or above the rung's budget, within tolerance. Charge in full. */
  | { status: 'ok'; area: number; budget: number }
  /** Materially fewer pixels than sold. Settle at the delivered rank and alert. */
  | { status: 'downgraded'; area: number; budget: number; ratio: number }
  /**
   * Nothing to compare. Either the rung is not a size (a quality tier), or it is a size
   * we have no budget for, or the asset could not be measured. Explicitly NOT a
   * downgrade: an unmeasured job must never trigger a refund.
   */
  | { status: 'unknown'; reason: string };

/**
 * The rung as SOLD, read from the job's frozen `workflow.params` alone.
 *
 * Deliberately NOT `priceResolutionForRequest`: that one consults the model's declared
 * ladder and answers `default` when the ladder is empty, so an admin editing a model's
 * capabilities between a job's enqueue and its run silently changes what the job records
 * as having been sold. This mirrors the expression the API itself prices with
 * (`jobs-routes.ts`, `shadowResolution`) — `resolution`, else `quality`, else default —
 * and reads only immutable request facts, so the answer cannot drift.
 */
export function soldRungFromParams(params: Record<string, unknown>): string {
  const resolution = params['resolution'];
  if (typeof resolution === 'string' && resolution) return resolution;
  const quality = params['quality'];
  if (typeof quality === 'string' && quality) return quality;
  return 'default';
}

export function deliveredRankBudget(rung: string | null | undefined): number | null {
  if (!rung || NON_SIZE_RUNGS.has(rung) || UNMEASURED_RUNGS.has(rung)) return null;
  return RUNG_BUDGET[rung]?.area ?? null;
}

/**
 * Compare what arrived against what was sold.
 *
 * `measured` is the delivered frame size. Pass `null` when the asset could not be
 * measured — the answer is `unknown`, never `downgraded`.
 */
export function judgeDeliveredRank(
  rung: string | null | undefined,
  measured: { width: number; height: number } | null,
): DeliveredRankVerdict {
  const budget = deliveredRankBudget(rung);
  if (budget === null) {
    return {
      status: 'unknown',
      reason: !rung
        ? 'no rung on the job'
        : NON_SIZE_RUNGS.has(rung)
          ? `rung "${rung}" is a quality tier, not a size`
          : UNMEASURED_RUNGS.has(rung)
            ? `rung "${rung}" is an image-ladder name whose pixel budget is vendor-specific and not yet measured`
            : `no pixel budget is declared for rung "${rung}"`,
    };
  }
  if (
    !measured ||
    measured.width <= 0 ||
    measured.height <= 0 ||
    !Number.isFinite(measured.width) ||
    !Number.isFinite(measured.height)
  ) {
    return { status: 'unknown', reason: 'the delivered asset could not be measured' };
  }
  const area = measured.width * measured.height;
  if (area > MAX_BELIEVABLE_AREA) {
    return { status: 'unknown', reason: `implausible measured area ${area}` };
  }
  const ratio = area / budget;
  if (ratio >= DELIVERED_AREA_TOLERANCE) return { status: 'ok', area, budget };

  // The AREA test alone is not sufficient, because the two semantics a vendor may use
  // for a `p` rung disagree — and both are legitimate:
  //
  //   * BUDGET semantics: fit ~921 600 pixels to whatever aspect the job implies. This
  //     is what kie did on the paid i2v probe (1108x830).
  //   * HEIGHT semantics: 720p means 720 lines, the literal reading. Under it a 1:1
  //     720p frame is 720x720 — 518 400 pixels, 56% of the 16:9 budget.
  //
  // Every active video model in the catalog offers 1:1 and portrait aspects, so under an
  // area-only rule a correct square 720p delivery scores 0,56 and gets refunded. A rung
  // is delivered if EITHER reading is satisfied; the short side is the rung's number
  // regardless of orientation, which is what makes 9:16 work.
  const shortSide = Math.min(measured.width, measured.height);
  const nominalShortSide = RUNG_BUDGET[rung as string]!.shortSide;
  if (shortSide >= nominalShortSide * DELIVERED_SHORT_SIDE_TOLERANCE) {
    return { status: 'ok', area, budget };
  }
  return { status: 'downgraded', area, budget, ratio };
}
