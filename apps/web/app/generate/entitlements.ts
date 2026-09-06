import {
  subscriptionTierAllows,
  subscriptionTierLabel,
  subscriptionTierRank,
} from '@seed/shared/subscription-tiers';

export { subscriptionTierAllows, subscriptionTierRank };

/** Russian upgrade copy for a locked model; unknown requirements never name a lower tier. */
export function lockedModelCtaLabel(requiredTier: unknown): string {
  const tierLabel = subscriptionTierLabel(requiredTier);
  return tierLabel ? `Открыть в тарифе «${tierLabel}»` : 'Открыть в подходящем тарифе';
}
