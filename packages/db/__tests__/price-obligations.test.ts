import { describe, expect, it } from 'vitest';
import {
  EXPIRING_PRICE_OBLIGATIONS,
  activePriceObligations,
  assertNoExpiredPriceObligations,
  expiredPriceObligations,
} from '../src';
import { PRICE_POINT_SEED } from '../seed/price-points';

describe('dated price obligations', () => {
  /**
   * This one reads the REAL clock on purpose, and that is the whole mechanism: on
   * 2026-08-24 it goes red and names the row to change. Do not "fix" it by freezing
   * the date — a price obligation nobody is forced to revisit is exactly the thing
   * rev. 15 §1 was written about, and this band already outlived its reason once.
   */
  it('has no expired price ruling today', () => {
    const now = new Date();
    expect(activePriceObligations(now)).toEqual(EXPIRING_PRICE_OBLIGATIONS);
    expect(expiredPriceObligations(now)).toEqual([]);
    expect(() => assertNoExpiredPriceObligations(now)).not.toThrow();
  });

  it('keeps the retired flux reference band inactive while the plain 1K row stays 11', () => {
    const rows = PRICE_POINT_SEED.filter(
      (point) =>
        point.modelId === 'flux-2-pro' &&
        point.resolution === '1K' &&
        point.videoInput === false &&
        point.audio === false &&
        point.mode === 'any',
    );
    const plain = rows.find((point) => point.refsMin === 0 && point.refsMax === null);
    const premiumBand = rows.find((point) => point.refsMin === 2 && point.refsMax === 8);

    expect(plain?.isActive).toBe(true);
    expect(plain?.baseCredits).toBe(11);
    expect(premiumBand?.isActive).toBe(false);
  });

  /**
   * Without this the obligation is prose: it could name a row that does not exist, or
   * keep saying "14-credit premium" after someone reprices the row to 13, and stay
   * green either way. Resolve the row through every column of the six-column price key
   * and assert the number.
   */
  it('names a real, active seed row and the credits it actually charges', () => {
    for (const obligation of EXPIRING_PRICE_OBLIGATIONS) {
      const matches = PRICE_POINT_SEED.filter(
        (point) =>
          point.modelId === obligation.modelId &&
          point.resolution === obligation.rung &&
          point.videoInput === obligation.videoInput &&
          point.audio === obligation.audio &&
          point.mode === obligation.mode &&
          point.refsMin === obligation.refsMin &&
          point.refsMax === obligation.refsMax,
      );

      expect(matches, `${obligation.key} matches no seed row`).toHaveLength(1);
      expect(matches[0]!.isActive, `${obligation.key} names an inactive row`).toBe(true);
      expect(matches[0]!.baseCredits, `${obligation.key} no longer charges what it claims`).toBe(
        obligation.credits,
      );
    }
  });

  it('keeps the obligation mechanism fail-closed when a future ruling is added', () => {
    const mechanism = [
      {
        key: 'test|1K|any|refs-2-8',
        modelId: 'test',
        rung: '1K',
        videoInput: false,
        audio: false,
        mode: 'any',
        referenceBand: 'refs-2-8',
        refsMin: 2,
        refsMax: 8,
        credits: 14,
        sourceRef: 'test',
        expiresOn: '2020-01-01',
        constraint: 'test constraint',
        reason: 'test reason',
        onExpiry: 'retire the exact test selector',
      },
    ] as const;

    expect(expiredPriceObligations(new Date('2020-01-02T00:00:00Z'), mechanism)).toEqual([
      mechanism[0],
    ]);
    expect(() =>
      assertNoExpiredPriceObligations(new Date('2020-01-02T00:00:00Z'), mechanism),
    ).toThrow('retire the exact test selector');
    expect(expiredPriceObligations(new Date('2019-12-31T00:00:00Z'), mechanism)).toEqual([]);
  });
});
