import type { CostLeg } from './cost-legs';
import { executableIdentity } from './cost-legs';
import type { CatalogueEntry } from './price-catalogue';

/** Roubles per US dollar for the leg's landed payment channel. */
export function landedRubPerUsd(leg: CostLeg): number {
  return leg.landedRubPerUnit;
}

function assertPositiveUnits(units: number): void {
  if (!Number.isFinite(units) || units <= 0) {
    throw new RangeError(`units must be finite and positive, got ${units}`);
  }
}

function landedCostAtUsd(leg: CostLeg, usd: number, units: number): number {
  assertPositiveUnits(units);
  return usd * landedRubPerUsd(leg) * units;
}

/** Landed rouble cost for the leg's signed worst-case USD rate. */
export function landedCostRub(leg: CostLeg, units: number): number {
  return landedCostAtUsd(leg, leg.usdPerUnit, units);
}

/**
 * USD cost at a particular input-reference count. A plain row has no reference
 * dimension; a band is priced only inside its own closed interval.
 */
export function usdAtReferenceCount(leg: CostLeg, references: number): number | null {
  if (leg.refsMin === 0 && leg.refsMax === 0) return leg.usdPerUnit;
  if (!Number.isFinite(references)) return null;
  if (references < leg.refsMin || references > leg.refsMax) return null;
  if (leg.bandPricing === 'плоская') return leg.usdPerUnit;
  return leg.usdPerUnit - leg.perImageSurchargeUsd * (leg.refsMax - references);
}

export interface CostedLeg {
  leg: CostLeg;
  landedRubTotal: number;
  upstream: string;
  executableIdentity: string;
}

export interface CostedLegOptions {
  units: number;
  references: number;
}

/** Cost every leg that covers this already-resolved catalogue entry. */
export function costedLegs(entry: CatalogueEntry, opts: CostedLegOptions): CostedLeg[] {
  assertPositiveUnits(opts.units);

  return entry.legs
    .flatMap((leg) => {
      const usd = usdAtReferenceCount(leg, opts.references);
      if (usd === null) return [];
      return [
        {
          leg,
          landedRubTotal: landedCostAtUsd(leg, usd, opts.units),
          upstream: leg.upstream,
          executableIdentity: executableIdentity(leg),
        },
      ];
    })
    .sort((a, b) => a.landedRubTotal - b.landedRubTotal || a.leg.leg - b.leg.leg);
}

/** Distinct suppliers serving this configuration, preserving leg order. */
export function upstreamsFor(entry: CatalogueEntry): string[] {
  return [...new Set(entry.legs.map((leg) => leg.upstream))];
}
