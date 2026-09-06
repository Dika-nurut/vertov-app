import type { CostLeg } from './cost-legs';

export const COST_FRESHNESS_MAX_AGE_DAYS = 60;
export const COST_FRESHNESS_REPRICED_MAX_AGE_DAYS = 14;
export const COST_FRESHNESS_MAX_AGE_MS = COST_FRESHNESS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
export const COST_FRESHNESS_REPRICED_MAX_AGE_MS =
  COST_FRESHNESS_REPRICED_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface VendorRepricingRecord {
  vendor: string;
  vendorRepricedOn: string;
  source: string;
}

/**
 * No repricing history is currently persisted. This stays empty on purpose: a record
 * here is a governed statement that a named vendor moved its rates on a named date, and
 * we have no such source. The short clock is not dead while it is empty — a leg signed
 * ГИПОТЕЗА reaches it through its own confidence, see `costFreshness`.
 */
export const VENDOR_REPRICING_HISTORY: readonly VendorRepricingRecord[] = [];

export interface CostFreshnessResult {
  fresh: boolean;
  ageDays: number;
  maxAgeDays: number;
  repriced: boolean;
  /** The leg's own signed confidence put it on the short clock, not a vendor record. */
  hypothesis: boolean;
  reason: string;
}

/** The fields freshness reads. Confidence is optional so callers holding a partial row
 *  (the parser's own tests, projections) still type-check; absent means HIGH. */
type FreshnessInput = Pick<CostLeg, 'capturedOn' | 'relay'> & Partial<Pick<CostLeg, 'confidence'>>;

export function staleCostLegs<T extends FreshnessInput>(
  legs: readonly T[],
  now: Date,
  repricingHistory: readonly VendorRepricingRecord[] = VENDOR_REPRICING_HISTORY,
): T[] {
  return legs.filter((leg) => !costFreshness(leg, now, repricingHistory).fresh);
}

export function costFreshness(
  leg: FreshnessInput,
  now: Date,
  repricingHistory: readonly VendorRepricingRecord[] = VENDOR_REPRICING_HISTORY,
): CostFreshnessResult {
  const capturedAt = Date.parse(`${leg.capturedOn}T00:00:00Z`);
  if (!Number.isFinite(capturedAt)) {
    return {
      fresh: false,
      ageDays: Number.POSITIVE_INFINITY,
      maxAgeDays: COST_FRESHNESS_MAX_AGE_DAYS,
      repriced: false,
      hypothesis: leg.confidence === 'HYPOTHESIS',
      reason: `cost capture date '${leg.capturedOn}' is invalid`,
    };
  }
  const repricedAt = repricingHistory
    .filter((record) => record.vendor.toLowerCase() === leg.relay.toLowerCase())
    .map((record) => Date.parse(`${record.vendorRepricedOn}T00:00:00Z`))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  // Repricing is a vendor-level ruling. Once it exists, every captured rate
  // from that vendor is held to the shorter budget; an older capture is not
  // allowed to retain the 60-day grace period merely because it predates the
  // repricing record.
  const repriced = repricedAt !== undefined;
  // A leg finance signed as ГИПОТЕЗА carries its own recheck cadence in the export —
  // the two grok-imagine-video Kie rows say «Перепроверка каждые 14 дней (R-8)» in the
  // ДОСТОВЕРНОСТЬ column itself. Keying the short clock only on a vendor-level record
  // meant those rows drew the full 60-day grace while the file said 14, and since
  // VENDOR_REPRICING_HISTORY is empty the short branch could never fire for anyone.
  // This reads a signed field; it does not infer a repricing event we have no source for.
  const hypothesis = leg.confidence === 'HYPOTHESIS';
  // РИСК (rev. 12) is finance saying the executing leg's rate is unpublished and one end
  // of its range loses money. That is not a slower-moving claim than ГИПОТЕЗА, so it draws
  // the same short clock — but it is reported as its own thing, because `hypothesis` is a
  // signed field and widening its meaning would make the result lie about the export.
  const shortClock = hypothesis || leg.confidence === 'RISK';
  const maxAgeDays =
    repriced || shortClock ? COST_FRESHNESS_REPRICED_MAX_AGE_DAYS : COST_FRESHNESS_MAX_AGE_DAYS;
  const ageDays = (now.getTime() - capturedAt) / (24 * 60 * 60 * 1000);
  const fresh = ageDays >= 0 && ageDays <= maxAgeDays;
  return {
    fresh,
    ageDays,
    maxAgeDays,
    repriced,
    hypothesis,
    reason: fresh
      ? `captured ${ageDays.toFixed(2)} days ago (limit ${maxAgeDays})`
      : `captured ${ageDays.toFixed(2)} days ago (limit ${maxAgeDays})`,
  };
}
