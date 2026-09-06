import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_LEG_FX_RUB,
  hasOfficialLegHeadroom,
  officialLegCostRub,
  officialLegRevenueRub,
  parseCapRub,
  withProspectiveLoss,
} from '../src/official-leg-budget';

/**
 * Finance's 2026-08-02 ruling on the third leg of the image chain (Ask 8, b):
 * keep it as ban-wave insurance inside a 3 000 ₽/day + 20 000 ₽/rolling-month
 * loss cap. This is the arithmetic and the cap-crossing decision.
 */

const CAPS = { dailyRub: 3000, monthlyRub: 20000 };

describe('cap parsing is fail-closed', () => {
  it('reads a finance-set number', () => {
    expect(parseCapRub(3000)).toBe(3000);
  });

  it('reads a numeric string the same way (jsonb round-trips loosely)', () => {
    expect(parseCapRub('20000')).toBe(20000);
  });

  it('treats a missing cap as zero, which turns the leg off', () => {
    // A DB without the seeded caps must not read as "unlimited" — that is the
    // uncapped status quo finance rejected.
    expect(parseCapRub(undefined)).toBe(0);
    expect(parseCapRub(null)).toBe(0);
  });

  it('treats a garbled or negative cap as zero', () => {
    expect(parseCapRub('lots')).toBe(0);
    expect(parseCapRub(-500)).toBe(0);
    expect(parseCapRub({ daily: 3000 })).toBe(0);
  });
});

describe('one job on the leg, in rubles', () => {
  it('prices a 4K Nano Banana Pro generation at the OpenRouter landed FX', () => {
    // The one invoice figure we hold: $0.241344 for a single 4K image.
    expect(officialLegCostRub(1, 0.241344)).toBeCloseTo(0.241344 * OFFICIAL_LEG_FX_RUB, 6);
  });

  it('scales with billable units', () => {
    expect(officialLegCostRub(3, 0.241344)).toBeCloseTo(3 * 0.241344 * OFFICIAL_LEG_FX_RUB, 6);
  });

  it('values revenue at the credit floor the customer actually spent', () => {
    expect(officialLegRevenueRub(50, 0.331)).toBeCloseTo(16.55, 6);
  });

  it('records no revenue for a job that settled at zero credits', () => {
    expect(officialLegRevenueRub(0, 0.331)).toBe(0);
  });
});

describe('the cap-crossing decision', () => {
  it('routes while both windows have headroom', () => {
    expect(hasOfficialLegHeadroom({ dayRub: 100, monthRub: 4000 }, CAPS)).toBe(true);
  });

  it('stops on the day cap even with month headroom to spare', () => {
    expect(hasOfficialLegHeadroom({ dayRub: 3000, monthRub: 3000 }, CAPS)).toBe(false);
  });

  it('stops on the month cap even on a quiet day', () => {
    expect(hasOfficialLegHeadroom({ dayRub: 0, monthRub: 20000 }, CAPS)).toBe(false);
  });

  it('never routes when the caps are unset', () => {
    expect(hasOfficialLegHeadroom({ dayRub: 0, monthRub: 0 }, { dailyRub: 0, monthlyRub: 0 })).toBe(
      false,
    );
  });
});

describe('the job asking for permission is part of the sum that decides', () => {
  it('adds its own worst case to both windows', () => {
    expect(withProspectiveLoss({ dayRub: 100, monthRub: 4000 }, 25.6)).toEqual({
      dayRub: 125.6,
      monthRub: 4025.6,
    });
  });

  it('refuses a job that would land exactly ON the day cap', () => {
    // 2 999 ₽ spent has headroom; a 1 ₽ loss does not fit under a 3 000 ₽ cap,
    // because the cap is the most we may have lost, not the most we may have
    // lost before this one. Strictly `<` is what makes that true.
    const spend = { dayRub: 2999, monthRub: 0 };
    expect(hasOfficialLegHeadroom(spend, CAPS)).toBe(true);
    expect(hasOfficialLegHeadroom(withProspectiveLoss(spend, 1), CAPS)).toBe(false);
  });

  it('refuses a single job larger than the whole remaining budget', () => {
    expect(
      hasOfficialLegHeadroom(withProspectiveLoss({ dayRub: 0, monthRub: 0 }, 3001), CAPS),
    ).toBe(false);
  });

  it('treats a nonsense prospective figure as zero rather than as free headroom', () => {
    expect(withProspectiveLoss({ dayRub: 10, monthRub: 10 }, Number.NaN)).toEqual({
      dayRub: 10,
      monthRub: 10,
    });
    expect(withProspectiveLoss({ dayRub: 10, monthRub: 10 }, -50)).toEqual({
      dayRub: 10,
      monthRub: 10,
    });
  });
});
