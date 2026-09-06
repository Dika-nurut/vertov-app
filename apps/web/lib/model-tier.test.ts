import { describe, expect, it } from 'vitest';
import { isModelLocked, tierRank, tierUpsellLabel, TIER_LABEL } from './model-tier';

/* The one entitlement ranking /generate and /boards share. It used to live
 * inline in GenerateClient, which is why the board picker had no gate at all. */
describe('tierRank', () => {
  it('orders free < start < creator', () => {
    expect(tierRank('free')).toBeLessThan(tierRank('start'));
    expect(tierRank('start')).toBeLessThan(tierRank('creator'));
  });

  it('treats a MISSING plan as free, but an UNKNOWN one as out of reach', () => {
    // Absent means "not subscribed" — that is genuinely free.
    expect(tierRank(undefined)).toBe(tierRank('free'));
    expect(tierRank(null)).toBe(tierRank('free'));
    // A tier string we do not recognise must fail CLOSED. Ranking it as free
    // would unlock every model behind it; ranking it above the top plan sorts it
    // last and keeps `isModelLocked` true. This mirrors
    // `subscriptionTierRank`, which returns null for an unknown tier so callers
    // fail closed — the same order `apps/api/src/jobs-routes.ts` enforces.
    expect(tierRank('enterprise-that-does-not-exist')).toBeGreaterThan(tierRank('max'));
  });

  it('ranks every tier above Креатор, so a max plan is not mistaken for free', () => {
    // Regression: a local 3-tier table ranked plus/pro/studio/max as 0 = free,
    // which locked the entire catalog for anyone above Креатор — including every
    // god-mode account used by e2e.
    for (const tier of ['plus', 'pro', 'studio', 'max']) {
      expect(tierRank(tier)).toBeGreaterThan(tierRank('creator'));
      expect(isModelLocked({ tierMin: 'creator' }, tier)).toBe(false);
    }
  });
});

describe('isModelLocked', () => {
  it('locks a model above the plan', () => {
    expect(isModelLocked({ tierMin: 'creator' }, 'start')).toBe(true);
    expect(isModelLocked({ tierMin: 'start' }, 'free')).toBe(true);
  });

  it('unlocks a model at or below the plan', () => {
    expect(isModelLocked({ tierMin: 'start' }, 'start')).toBe(false);
    expect(isModelLocked({ tierMin: 'start' }, 'creator')).toBe(false);
    expect(isModelLocked({ tierMin: 'free' }, null)).toBe(false);
  });

  it('treats a row with no tierMin as free (older API responses)', () => {
    expect(isModelLocked({}, null)).toBe(false);
  });
});

describe('tierUpsellLabel', () => {
  it('names the plan that unlocks the model', () => {
    expect(tierUpsellLabel({ tierMin: 'start' })).toBe(`Открыть в тарифе «${TIER_LABEL['start']}»`);
    expect(tierUpsellLabel({ tierMin: 'creator' })).toBe('Открыть в тарифе «Креатор»');
  });

  it('falls back to the top plan for an unknown row', () => {
    expect(tierUpsellLabel(undefined)).toBe('Открыть в тарифе «Креатор»');
  });
});
