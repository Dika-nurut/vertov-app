/**
 * Parametric credit pricing — PURE logic, no DB, no I/O.
 *
 * The token cost of a generation is a function of
 * (model × resolution × videoInput × audio × duration): the vendor prices those
 * dimensions very differently, so the flat `models.creditCostPerUnit × units`
 * path over-charges on cheap configs (seedance 480p 2–4×) while a single rate
 * can't track the dear ones. This module is the price kernel the API charge and
 * worker settlement both compute against.
 *
 * Responsibilities, split so each is trivially testable:
 *   1. `computeUnits`          — how many billable units a request consumes
 *                                (output seconds or image count). Resolution
 *                                and audio do NOT change the unit count — they
 *                                select a different price point (a different rate).
 *   2. `selectPricePoint`      — pick the (resolution × videoInput × audio) row.
 *   3. `priceTokens`           — turn units into credits for a chosen price point.
 *   4. `resolveParametricPrice`— apply (2)+(3), or REFUSE. It never returns flat.
 *   5. missing or malformed rows are refused; there is no flat-price path.
 *
 * Price math uses no stored or accumulated floats:
 *   scaling: tokens = ceil(baseCredits × units / baseUnits)
 *   flat:    tokens = baseCredits for any positive units
 *   plus:    creditsPerExtra × max(0, referenceCount − included) × imageCount
 * `baseCredits` is the workbook ladder value for a base-duration render or one
 * whole clip; `baseUnits` is that base duration in seconds, or 1 for images/clips.
 */

export type PricingUnitKind = 'second' | 'image';

/** Additive vendor charge for items beyond the included count. */
export interface PerItemPriceTerm {
  included: number;
  creditsPerExtra: number;
}

/** A single priced (model × resolution × videoInput × audio) row. */
export interface PricePoint {
  modelId: string;
  /** Discrete resolution/quality step, or 'default' when the model has none. */
  resolution: string;
  videoInput: boolean;
  audio: boolean;
  unitKind: PricingUnitKind;
  /** Workbook ladder credits for a base-duration render at this config. */
  baseCredits: number;
  /** Base duration (s) the ladder credits are quoted at; 1 for images/flat rows. */
  baseUnits: number;
  /** One charge for the whole job, whatever the duration — see the schema comment. */
  flatRate?: boolean;
  /**
   * Optional additive term for vendor-metered reference images. Mutually
   * exclusive with a reference band: a band is ONE flat price for the whole band,
   * so a per-extra term on top would charge again for the references the band
   * already covers. A row carrying both is refused rather than guessed at.
   */
  perItem?: PerItemPriceTerm | null;
  /** Generation mode this row prices; absent or `'any'` matches any request. */
  mode?: string;
  /** Reference band: absent/0 and null match any input-image count. */
  refsMin?: number;
  refsMax?: number | null;
}

/** The model-level facts `computeUnits` needs (a subset of a `models` row). */
export interface ComputeUnitsModel {
  kind: string;
  /** Vendor floor — a render shorter than this still bills at this many s. */
  minDurationSeconds?: number | null;
  /** Vendor ceiling — output seconds are capped here before billing. */
  maxDurationSeconds?: number | null;
}

/** Price-affecting request params (a subset of the job's `params`). */
export interface PricingParams {
  /** Requested output duration (video). */
  durationSeconds?: number;
  /** Image count. */
  n?: number;
}

/** Selector for `selectPricePoint`. */
export interface PricePointSelector {
  resolution: string;
  videoInput?: boolean;
  audio?: boolean;
  /** The request's generation mode, when the caller derives one. */
  mode?: string;
}

export type ComputeUnitsResult = { ok: true; units: number } | { ok: false; error: string };

/**
 * Billable units for a request.
 *
 * - image: `ceil(n)`, floored at 1.
 * - video: `ceil(output)` clamped to `[minDurationSeconds, maxDurationSeconds]`.
 *
 * With-video billing intentionally stays out of this client-param kernel. It
 * remains on the production output-only flat path until finance freezes its
 * rate and the server has a trusted input-duration source.
 */
export function computeUnits(model: ComputeUnitsModel, params: PricingParams): ComputeUnitsResult {
  if (model.kind === 'video') {
    const duration = Number(params.durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, error: 'duration_seconds_required' };
    }
    let output = Math.ceil(duration);

    // Vendor floor: never bill below the model's minimum billable duration.
    const min = model.minDurationSeconds;
    if (min != null && min > 0 && output < min) {
      output = min;
    }
    // Vendor ceiling: cap output seconds (mirrors the live `maxDurationSeconds`
    // clamp in unitsForGenerationModel).
    const max = model.maxDurationSeconds;
    if (max != null && max > 0 && output > max) {
      output = max;
    }

    return { ok: true, units: output };
  }

  // Images (and image-edit): billed per generated image.
  const count = Number(params.n);
  return {
    ok: true,
    units: Number.isFinite(count) && count > 0 ? Math.ceil(count) : 1,
  };
}

/**
 * Pick the price point matching a selector, or `undefined` if the model has no
 * row for that config. `undefined` is the mechanism behind hard caps: a model
 * with no 1080p row (grok is 480p/720p only) returns `undefined` for 1080p, and
 * the caller must refuse rather than silently substitute another row.
 */
export function selectPricePoint(
  points: readonly PricePoint[],
  selector: PricePointSelector,
): PricePoint | undefined {
  const videoInput = selector.videoInput ?? false;
  const audio = selector.audio ?? false;
  return points.find(
    (p) => p.resolution === selector.resolution && p.videoInput === videoInput && p.audio === audio,
  );
}

/**
 * Credits for `units` billable units at a price point. Per-second/image prices
 * round UP so a fractional rate never undercharges. Flat-rate prices charge once for
 * any valid positive unit count, because that is how the vendor bills the request.
 * A vendor-metered reference fee is additive on top of either shape.
 */
function referenceCountForPrice(referenceCount: number): number {
  return Number.isFinite(referenceCount) && referenceCount > 0 ? Math.ceil(referenceCount) : 0;
}

function extraReferenceCredits(pricePoint: PricePoint, referenceCount: number): number {
  const perItem = pricePoint.perItem;
  if (!perItem) return 0;
  const extraReferences = Math.max(0, referenceCountForPrice(referenceCount) - perItem.included);
  return perItem.creditsPerExtra * extraReferences;
}

/**
 * Credits for `units` with the request's reference-image count.
 *
 * Kie's Seedream image adapter submits one vendor task per generated image, so its
 * per-reference input fee is charged once per image rather than once per request.
 * `imageUnitCredits` uses the corresponding one-image value for worker settlement.
 */
export function priceTokens(pricePoint: PricePoint, units: number, referenceCount = 0): number {
  // Validate before the flat short-circuit: a nonsense duration is not made valid
  // merely because it would not change the charge.
  if (!Number.isFinite(units) || units <= 0) return 0;
  const perImageCount = pricePoint.unitKind === 'image' ? Math.ceil(units) : 1;
  const extras = extraReferenceCredits(pricePoint, referenceCount) * perImageCount;
  // Flat is a property of the BASE tariff, not of the whole charge: a vendor that
  // bills one price per clip can still meter input images. No row carries both
  // today, and returning early would silently drop the metered part if one did.
  if (pricePoint.flatRate) return pricePoint.baseCredits + extras;
  const base = pricePoint.baseUnits > 0 ? pricePoint.baseUnits : 1;
  return Math.ceil((pricePoint.baseCredits * units) / base) + extras;
}

/** Money values beyond this are treated as corrupt/crafted input, not prices. */
export const MAX_RESOLVED_PRICE_CREDITS = 1_000_000_000;

/**
 * The cheapest per-unit credit rate across a model's active price points — the
 * "from N credits" figure for client-side ordering (pickers, defaults, the
 * «Черновик» chip). Mirrors `priceTokens`' rounding: per-second/image rows rate
 * at `ceil(baseCredits / baseUnits)`, flat rows charge `baseCredits` per job.
 * Returns `null` when the model has no active row — callers must treat that as
 * "unpriced", never as 0.
 */
export function minUnitCredits(points: readonly PricePoint[]): number | null {
  let min: number | null = null;
  for (const point of points) {
    const rate =
      point.flatRate || !(point.baseUnits > 0)
        ? point.baseCredits
        : Math.ceil(point.baseCredits / point.baseUnits);
    if (min === null || rate < min) min = rate;
  }
  return min;
}

function isSafeCost(cost: number): boolean {
  return (
    Number.isFinite(cost) &&
    Number.isSafeInteger(cost) &&
    cost > 0 &&
    cost <= MAX_RESOLVED_PRICE_CREDITS
  );
}

export interface ResolvedPrice {
  /** Credits to reserve/charge for this request. */
  cost: number;
  /**
   * Effective per-image credit rate the worker must settle image jobs at, so
   * settlement == charge. It includes the selected point's base rate and any
   * per-item term for this request. For image points, `units` is required to be
   * a positive integer, so `cost == imageUnitCredits × units`; fractional image
   * units are refused. `null` means the job is video (video settles the full
   * reserved amount when any asset returns).
   */
  imageUnitCredits: number | null;
  source: 'parametric';
}

/**
 * `ok:false` is a refusal to quote, not an error to swallow — charging anything
 * would be either a silent flat-charge (and an adapter downgrade) or a mispriced
 * row. The caller must refuse the job. Two stable machine codes, because the two
 * conditions have different causes and different fixes:
 *
 * - `config_not_available` — THE CLIENT asked for a config the ladder
 *   deliberately does not carry (1080p on a 480p/720p model). Fix: ask for a
 *   config we sell. This is the no-silent-downgrade hard cap.
 * - `price_unavailable` — WE have no usable price for a config we do sell: no
 *   active rows at all, or the matching row is malformed, or the arithmetic
 *   overflowed. Fix: repair the price table. Never chargeable.
 */
export type ResolveParametricResult =
  | { ok: true; price: ResolvedPrice }
  | { ok: false; error: 'config_not_available' | 'price_unavailable' };

/**
 * A price point is USABLE only if its rational-formula inputs are finite and
 * strictly positive. A malformed active row (a bad seed/migration, or an admin
 * fat-finger that slipped a DB CHECK) must never crash the charge, zero it, or
 * make it negative — it is treated as if it did not exist, and the request is
 * REFUSED rather than 500ing or quietly billing the resolution-blind flat rate.
 * Mirrors the DB CHECK constraints on `model_price_points` (base_credits > 0,
 * base_units > 0), so a row that fails this is corruption, not a client problem.
 */
function isUsablePricePoint(p: PricePoint): boolean {
  const perItem = p.perItem;
  const usablePerItem =
    perItem == null ||
    (typeof perItem === 'object' &&
      Number.isSafeInteger(perItem.included) &&
      perItem.included >= 0 &&
      Number.isSafeInteger(perItem.creditsPerExtra) &&
      perItem.creditsPerExtra >= 0);
  const min = p.refsMin ?? 0;
  const max = p.refsMax ?? null;
  const usableBand =
    Number.isSafeInteger(min) &&
    min >= 0 &&
    (max === null || (Number.isSafeInteger(max) && max >= min)) &&
    // A band is ONE flat price for the whole band. A row that also carries a
    // per-extra term would charge again for the references the band already
    // covers, and there is no reading of such a row that is obviously right — so
    // it is malformed, not merely odd.
    !(min > 0 && perItem != null);
  return (
    Number.isFinite(p.baseCredits) &&
    p.baseCredits > 0 &&
    Number.isFinite(p.baseUnits) &&
    p.baseUnits > 0 &&
    usablePerItem &&
    usableBand
  );
}

/**
 * Resolve the credit cost for a request over `units` billable units — from the
 * price table, or not at all. This function NEVER returns a flat rate.
 *
 * Outcomes, in this order:
 *   - NO usable active price point (none seeded, or every active row is
 *     malformed) → REFUSE `price_unavailable`. A missing price is a DATA
 *     FAILURE and must be visible: the old silent flat fallback here is exactly
 *     what billed a 480p Seedance clip at the 1080p-blind rate (1600 vs 128).
 *   - a usable point matches the requested (resolution × videoInput × audio) →
 *     parametric price for that exact config.
 *   - usable points exist but NONE matches the requested config → REFUSE
 *     `config_not_available`. This is the hard cap: a 1080p ask on a
 *     480p/720p-only model must not be charged and silently downgraded.
 *   - the requested row exists but is malformed, or the arithmetic overflows →
 *     REFUSE `price_unavailable`, same reasoning as the first case.
 *
 * The SAME resolver is called at estimate, charge, and — via the persisted
 * `imageUnitCredits` — worker settlement, so all three agree by construction.
 */
/** Does this row price the request's mode? `'any'` prices every mode. */
export function pointServesMode(pricePoint: PricePoint, mode: string | undefined): boolean {
  const rowMode = pricePoint.mode ?? 'any';
  return rowMode === 'any' || rowMode === (mode ?? 'any');
}

/** Does this row's reference band contain the request's input-image count? */
export function pointServesReferenceCount(pricePoint: PricePoint, referenceCount: number): boolean {
  const count = referenceCountForPrice(referenceCount);
  const min = pricePoint.refsMin ?? 0;
  const max = pricePoint.refsMax ?? null;
  return count >= min && (max === null || count <= max);
}

/**
 * How specifically a row describes the request. An exact mode outranks `'any'`,
 * and a band that starts above zero outranks one that starts at zero — both are
 * the row saying something narrower about the request than the fallback does.
 *
 * The two axes are weighted so mode dominates: a row for THIS mode is about this
 * request, while a band is about its inputs, and a mode-specific row must never
 * lose to a generic banded one. Rows that agree on both are indistinguishable and
 * the caller refuses rather than choosing.
 */
function pointSpecificity(pricePoint: PricePoint): number {
  const modeScore = (pricePoint.mode ?? 'any') === 'any' ? 0 : 2;
  const bandScore = (pricePoint.refsMin ?? 0) > 0 ? 1 : 0;
  return modeScore + bandScore;
}

export function resolveParametricPrice(
  activePoints: readonly PricePoint[],
  selector: PricePointSelector,
  units: number,
  referenceCount = 0,
): ResolveParametricResult {
  const usablePoints = activePoints.filter(isUsablePricePoint);
  // No usable parametric data at all. Covers "no active rows for this model"
  // (the price table is incomplete — our bug) and "every active row is
  // malformed" (corruption). Both are unquotable; neither is chargeable.
  if (usablePoints.length === 0) return { ok: false, error: 'price_unavailable' };
  const requestedRows = activePoints.filter(
    (p) =>
      p.resolution === selector.resolution &&
      p.videoInput === (selector.videoInput ?? false) &&
      p.audio === (selector.audio ?? false) &&
      pointServesMode(p, selector.mode) &&
      pointServesReferenceCount(p, referenceCount),
  );
  const usable = requestedRows.filter(isUsablePricePoint);
  // Most specific wins, and a tie is a refusal. Two rows offering two prices for
  // one request shape is a data defect: picking either would make the charge a
  // function of array order, which is how a price becomes unexplainable.
  const ranked = [...usable].sort((a, b) => pointSpecificity(b) - pointSpecificity(a));
  const point = ranked[0];
  if (point && ranked.length > 1 && pointSpecificity(ranked[1]!) === pointSpecificity(point)) {
    return { ok: false, error: 'price_unavailable' };
  }
  // The config exists but every row for it is malformed: a data failure, not an
  // unsupported client config — a different code, and still not chargeable.
  if (!point && requestedRows.length > 0) return { ok: false, error: 'price_unavailable' };
  // Usable rows exist but the requested config is not among them → hard cap.
  if (!point) return { ok: false, error: 'config_not_available' };
  // Worker settlement stores one effective image rate and multiplies it by the
  // returned image count. Fractional image units would make that invariant false
  // because the base charge is rounded independently, so refuse them explicitly.
  if (point.unitKind === 'image' && !Number.isInteger(units)) {
    return { ok: false, error: 'price_unavailable' };
  }
  const cost = priceTokens(point, units, referenceCount);
  // Only reachable from a crafted/corrupt unit count; an untrustworthy number is
  // not a price, so refuse rather than substitute the flat rate for it.
  if (!isSafeCost(cost)) return { ok: false, error: 'price_unavailable' };
  const imageUnitCredits =
    point.unitKind === 'image'
      ? point.baseCredits + extraReferenceCredits(point, referenceCount)
      : null;
  if (imageUnitCredits !== null && !isSafeCost(imageUnitCredits)) {
    return { ok: false, error: 'price_unavailable' };
  }
  // Assert the documented image-row basis (baseUnits=1) instead of allowing a
  // malformed row to break the persisted-rate settlement invariant.
  if (imageUnitCredits !== null && cost !== imageUnitCredits * units) {
    return { ok: false, error: 'price_unavailable' };
  }
  return {
    ok: true,
    price: {
      cost,
      imageUnitCredits,
      source: 'parametric',
    },
  };
}
