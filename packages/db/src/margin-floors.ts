import type { CostLegRole } from './cost-legs';

/**
 * Margin floors shared by the catalogue guardrails and admin write gates.
 *
 * These are fractions of revenue, not percentage points. Keep them here so a
 * CI exception and an operator override cannot silently use different policy.
 */
export const PRIMARY_MARGIN_FLOOR = 0.25;
/**
 * ZERO, per standing ruling R-1 — not the 5% this constant carried before.
 * Refusing to fail over converts a vendor outage into our own, so a thin reserve is
 * the point rather than an embarrassment; finance prices several legs deliberately at
 * break-even. The 5% had no ruling behind it and turned every honest thin leg into a
 * CI failure needing a hand-written exemption — which is how an exemption list grows
 * until it means nothing. Below zero is a different thing and stays forbidden: that is
 * selling at a loss, and R-11 governs it with a spend cap rather than a price rule.
 */
export const FALLBACK_MARGIN_FLOOR = 0;
export const WORST_DURATION_MARGIN_FLOOR = 0.15;

export interface ExpiringMarginException {
  key: string;
  expiresOn: string;
  referenceFloor?: number;
  worstDurationFloor?: number;
  reason: string;
}

/** No standing exception is active; any future one must carry an expiry. */
export const DURATION_FLOOR_EXCEPTIONS: ExpiringMarginException[] = [];

/** Derive the applicable floor from finance's parsed `Роль`, never from a gateway name. */
export function marginFloorForRole(role: CostLegRole): number {
  return role === 'primary' ? PRIMARY_MARGIN_FLOOR : FALLBACK_MARGIN_FLOOR;
}

export function activeMarginExceptions(
  now: Date,
  exceptions: readonly ExpiringMarginException[] = DURATION_FLOOR_EXCEPTIONS,
): readonly ExpiringMarginException[] {
  return exceptions.filter((exception) => {
    const expires = Date.parse(`${exception.expiresOn}T00:00:00Z`);
    return Number.isFinite(expires) && expires > now.getTime();
  });
}

/**
 * Expired rulings are configuration errors, not silently inactive overrides.
 * Keep this separate from `activeMarginExceptions`: callers that apply a floor
 * need the active subset, while the CI guard must fail when production data
 * still contains a ruling whose expiry has passed.
 */
export function expiredMarginExceptions(
  now: Date,
  exceptions: readonly ExpiringMarginException[] = DURATION_FLOOR_EXCEPTIONS,
): readonly ExpiringMarginException[] {
  return exceptions.filter((exception) => {
    const expires = Date.parse(`${exception.expiresOn}T00:00:00Z`);
    return !Number.isFinite(expires) || expires <= now.getTime();
  });
}

export function assertNoExpiredMarginExceptions(
  now: Date,
  exceptions: readonly ExpiringMarginException[] = DURATION_FLOOR_EXCEPTIONS,
): void {
  const expired = expiredMarginExceptions(now, exceptions);
  if (expired.length > 0) {
    throw new Error(
      `expired margin rulings: ${expired.map((exception) => exception.key).join(', ')}`,
    );
  }
}
