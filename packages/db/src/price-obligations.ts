/**
 * A temporary price is a dated finance ruling, not an undocumented override.
 * Keep the expiry and the required post-expiry operation beside the price
 * configuration so a premium cannot outlive the constraint that justified it.
 *
 * Deliberately its own type rather than an extension of `ExpiringMarginException`:
 * the two share a shape (a key, a date, a reason) and nothing else. A margin
 * exception relaxes a FLOOR and carries `referenceFloor`/`worstDurationFloor`; a
 * price obligation names a ROW and what to do with it. Inheriting would have given
 * every obligation two floor fields that mean nothing here.
 *
 * `constraint` is the field the ruling actually turns on. rev. 15 §1: "a price that
 * exists because of a CONSTRAINT must carry the constraint's name and an expiry" —
 * the flux band was 27% dearer purely because kie refused 2+ references, our
 * kie-adapter fix of 2026-08-09 removed that, and the premium outlived its reason
 * without anything noticing.
 */
export interface ExpiringPriceObligation {
  key: string;
  expiresOn: string;
  reason: string;
  modelId: string;
  rung: string;
  videoInput: boolean;
  audio: boolean;
  /**
   * The row's `mode`, not its billing unit. This field read 'image' until 2026-08-11,
   * which is the UNIT column — the row's mode is the seed default `any`. A key nobody
   * can look up is the same as no key at all, so the fields below name every column of
   * the six-column price key and the binding test resolves the row with them.
   */
  mode: string;
  referenceBand: string;
  refsMin: number;
  refsMax: number | null;
  /** The credits the row must currently charge. Prose cannot go red; a number can. */
  credits: number;
  sourceRef: string;
  constraint: string;
  onExpiry: string;
}

/**
 * The price-point identity fields needed to bind a dated finance obligation to
 * the runtime row. Kept structural so this module does not depend on the API or
 * credits packages.
 */
export interface PricePointObligationIdentity {
  modelId: string;
  resolution: string;
  videoInput: boolean;
  audio: boolean;
  mode?: string | null;
  refsMin?: number | null;
  refsMax?: number | null;
}

export const EXPIRING_PRICE_OBLIGATIONS: ExpiringPriceObligation[] = [];

function obligationExpiry(obligation: ExpiringPriceObligation): number {
  return Date.parse(`${obligation.expiresOn}T00:00:00Z`);
}

/** Return the expired ruling bound to a precise active price-point row, if any. */
export function expiredPriceObligationForPoint(
  point: PricePointObligationIdentity,
  now: Date,
  obligations: readonly ExpiringPriceObligation[] = EXPIRING_PRICE_OBLIGATIONS,
): ExpiringPriceObligation | undefined {
  return obligations.find((obligation) => {
    const expires = obligationExpiry(obligation);
    return (
      (!Number.isFinite(expires) || expires <= now.getTime()) &&
      obligation.modelId === point.modelId &&
      obligation.rung === point.resolution &&
      obligation.videoInput === point.videoInput &&
      obligation.audio === point.audio &&
      obligation.mode === (point.mode ?? 'any') &&
      obligation.refsMin === (point.refsMin ?? 0) &&
      obligation.refsMax === (point.refsMax ?? null)
    );
  });
}

export function activePriceObligations(
  now: Date,
  obligations: readonly ExpiringPriceObligation[] = EXPIRING_PRICE_OBLIGATIONS,
): readonly ExpiringPriceObligation[] {
  return obligations.filter((obligation) => {
    const expires = obligationExpiry(obligation);
    return Number.isFinite(expires) && expires > now.getTime();
  });
}

/** Expired rulings are configuration errors, not silently inactive prices. */
export function expiredPriceObligations(
  now: Date,
  obligations: readonly ExpiringPriceObligation[] = EXPIRING_PRICE_OBLIGATIONS,
): readonly ExpiringPriceObligation[] {
  return obligations.filter((obligation) => {
    const expires = obligationExpiry(obligation);
    return !Number.isFinite(expires) || expires <= now.getTime();
  });
}

export function assertNoExpiredPriceObligations(
  now: Date,
  obligations: readonly ExpiringPriceObligation[] = EXPIRING_PRICE_OBLIGATIONS,
): void {
  const expired = expiredPriceObligations(now, obligations);
  if (expired.length > 0) {
    throw new Error(
      `expired price obligations: ${expired
        .map((obligation) => `${obligation.key}: ${obligation.onExpiry}`)
        .join('; ')}`,
    );
  }
}
