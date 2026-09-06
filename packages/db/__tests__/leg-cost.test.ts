import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedSubscriptionTiers } from '../seed/subscription-catalog';
import { parseCostLegs } from '../src/cost-legs';
import { buildCatalogue, entryKey } from '../src/price-catalogue';
import {
  costedLegs,
  landedCostRub,
  landedRubPerUsd,
  upstreamsFor,
  usdAtReferenceCount,
} from '../src/leg-cost';
import { creditFloorRub } from '../src/price-breakeven';

const file = parseCostLegs(readFileSync(join(__dirname, '../seed/cost-legs.csv'), 'utf8'));
const catalogue = buildCatalogue(file);
const byKey = new Map(catalogue.map((entry) => [entryKey(entry), entry]));

describe('Phase 1 leg cost kernel', () => {
  it('P1-1: sorts by landed cost and breaks ties by leg number', () => {
    const entry = byKey.get('seedance-2-0|720p|t2v|нет|-|any');
    if (!entry) throw new Error('seedance 720p fixture missing');

    const sorted = costedLegs(entry, { units: 5, references: 0 });
    expect(sorted.map((candidate) => candidate.leg.leg)).toEqual([1, 2]);
    expect(sorted[0]!.landedRubTotal).toBeLessThan(sorted[1]!.landedRubTotal);

    const tied = {
      ...entry,
      legs: entry.legs.map((leg) => ({ ...leg, usdPerUnit: 0.1, landedRubPerUnit: 100 })),
    };
    expect(
      costedLegs(tied, { units: 1, references: 0 }).map((candidate) => candidate.leg.leg),
    ).toEqual([1, 2]);
  });

  it('P1-2: uses the unrounded landed FX, never costRubDisplay', () => {
    const leg = file.legs.find(
      (candidate) => candidate.usdPerUnit * candidate.landedRubPerUnit !== candidate.costRubDisplay,
    );
    if (!leg) throw new Error('fixture needs an unrounded display-cost difference');

    expect(landedRubPerUsd(leg)).toBe(leg.landedRubPerUnit);
    expect(landedCostRub(leg, 1)).toBe(leg.usdPerUnit * leg.landedRubPerUnit);
    expect(landedCostRub(leg, 1)).not.toBe(leg.costRubDisplay);
  });

  it('P1-4: refuses a reference count outside the leg band', () => {
    const band = file.legs.find((leg) => leg.refsMin === 2 && leg.refsMax === 10);
    if (!band) throw new Error('per-extra reference band fixture missing');

    expect(usdAtReferenceCount(band, 1)).toBeNull();
    expect(usdAtReferenceCount(band, 11)).toBeNull();
    expect(usdAtReferenceCount(band, 2)).not.toBeNull();
  });

  it('P1-5: prices a per-extra band at its signed ceiling rate', () => {
    const floor = creditFloorRub(seedSubscriptionTiers);
    const bands = file.legs.filter((leg) => leg.refsMin > 0);
    expect(bands).not.toHaveLength(0);

    for (const leg of bands) {
      const entry = byKey.get(entryKey(leg));
      if (!entry) throw new Error(`${entryKey(leg)} catalogue entry missing`);
      expect(usdAtReferenceCount(leg, leg.refsMax)).toBe(leg.usdPerUnit);

      const cost = leg.usdPerUnit * landedRubPerUsd(leg) * entry.baseUnits;
      const margin = 1 - cost / (entry.credits * floor);
      expect(margin).toBeCloseTo(leg.margin, 5);
    }
  });

  it('uses the self-contained and cross-row per-extra formulas at every band count', () => {
    const plain = file.legs.find(
      (leg) => leg.modelId === 'seedream-5-0-pro' && leg.rung === '1K' && leg.refsMax === 1,
    );
    const band = file.legs.find(
      (leg) => leg.modelId === 'seedream-5-0-pro' && leg.rung === '1K' && leg.refsMin === 2,
    );
    if (!plain || !band) throw new Error('seedream cross-row band fixtures missing');

    for (let references = band.refsMin; references <= band.refsMax; references += 1) {
      expect(usdAtReferenceCount(band, references)).toBeCloseTo(
        plain.usdPerUnit + band.perImageSurchargeUsd * (references - 1),
        12,
      );
    }
    expect(usdAtReferenceCount(band, 2)).toBeCloseTo(0.0375, 12);
    expect(usdAtReferenceCount(band, 10)).toBeCloseTo(0.0575, 12);
  });

  it('P1-6: a per-extra band costs less at N=2 than at N=10', () => {
    const entry = byKey.get('seedream-5-0-pro|1K|refs-2-10|-|-|any');
    if (!entry) throw new Error('seedream 1K reference-band entry missing');

    const atTwo = costedLegs(entry, { units: 1, references: 2 });
    const atTen = costedLegs(entry, { units: 1, references: 10 });
    expect(atTwo).toHaveLength(1);
    expect(atTen).toHaveLength(1);
    expect(atTwo[0]!.landedRubTotal).toBeLessThan(atTen[0]!.landedRubTotal);
  });

  it('returns distinct upstream suppliers from the data, not relay labels', () => {
    const upstreams = new Set(catalogue.flatMap((entry) => upstreamsFor(entry)));
    expect(upstreams).toEqual(
      new Set([
        'Alibaba',
        'Black Forest Labs',
        'ByteDance',
        'Google',
        'Kuaishou',
        'OpenAI',
        'Recraft',
        'xAI',
      ]),
    );
  });

  it('P1-11: rejects non-finite and non-positive units', () => {
    const leg = file.legs[0]!;
    for (const units of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => landedCostRub(leg, units)).toThrow(/units must be finite and positive/);
    }
    const entry = byKey.get(entryKey(leg));
    if (!entry) throw new Error('first catalogue entry missing');
    expect(() => costedLegs(entry, { units: 0, references: 0 })).toThrow(
      /units must be finite and positive/,
    );
  });
});
