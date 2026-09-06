import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_TIER_ORDER, subscriptionTierAllows } from '@seed/shared/subscription-tiers';
import { lockedModelCtaLabel } from './entitlements';

describe('Generate subscription entitlements', () => {
  it('allows exactly the models at or below every supported tier', () => {
    for (const currentTier of SUBSCRIPTION_TIER_ORDER) {
      for (const requiredTier of SUBSCRIPTION_TIER_ORDER) {
        expect(subscriptionTierAllows(currentTier, requiredTier)).toBe(
          SUBSCRIPTION_TIER_ORDER.indexOf(currentTier) >=
            SUBSCRIPTION_TIER_ORDER.indexOf(requiredTier),
        );
      }
    }
  });

  it('fails closed for unknown tiers while preserving legacy rows with no minimum', () => {
    expect(subscriptionTierAllows('max', 'enterprise-preview')).toBe(false);
    expect(subscriptionTierAllows('enterprise-preview', 'start')).toBe(false);
    expect(subscriptionTierAllows('enterprise-preview', 'free')).toBe(false);
    expect(subscriptionTierAllows(null, 'start')).toBe(false);
    expect(subscriptionTierAllows('free', null)).toBe(true);
    expect(subscriptionTierAllows(null, undefined)).toBe(true);
  });

  it('uses the model minimum tier in the Russian upgrade CTA', () => {
    expect(lockedModelCtaLabel('start')).toBe('Открыть в тарифе «Старт»');
    expect(lockedModelCtaLabel('creator')).toBe('Открыть в тарифе «Креатор»');
    expect(lockedModelCtaLabel('plus')).toBe('Открыть в тарифе «Плюс»');
    expect(lockedModelCtaLabel('pro')).toBe('Открыть в тарифе «Про»');
    expect(lockedModelCtaLabel('studio')).toBe('Открыть в тарифе «Студия»');
    expect(lockedModelCtaLabel('max')).toBe('Открыть в тарифе «Макс»');
    expect(lockedModelCtaLabel('unknown')).toBe('Открыть в подходящем тарифе');
  });
});
