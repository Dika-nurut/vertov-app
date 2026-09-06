import { SUBSCRIPTION_TIER_LABELS, type SubscriptionTier } from '@seed/shared/subscription-tiers';

export type Tier = SubscriptionTier;

/** Russian names for every current and legacy subscription tier. */
export const TIER_LABEL: Readonly<Record<Tier, string>> = {
  ...SUBSCRIPTION_TIER_LABELS,
  // Settings has always called this state «Free» (as does ProfileMenu).
  free: 'Free',
};

/** Catalog titles are authoritative when the billing endpoint supplies one. */
export function tierLabel(tier: Tier, title?: string | null): string {
  return title ?? TIER_LABEL[tier];
}
