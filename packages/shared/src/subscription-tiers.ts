/**
 * Canonical subscription order for entitlement checks. Keep this independent
 * from the database enum declaration: the enum's historical insertion order
 * is not the product entitlement order.
 */
export const SUBSCRIPTION_TIER_ORDER = [
  'free',
  'start',
  'creator',
  'plus',
  'pro',
  'studio',
  'max',
] as const;

export type SubscriptionTier = (typeof SUBSCRIPTION_TIER_ORDER)[number];

export const SUBSCRIPTION_TIER_LABELS: Readonly<Record<SubscriptionTier, string>> = {
  free: 'Бесплатный',
  start: 'Старт',
  creator: 'Креатор',
  plus: 'Плюс',
  pro: 'Про',
  studio: 'Студия',
  max: 'Макс',
};

export function isSubscriptionTier(tier: unknown): tier is SubscriptionTier {
  return typeof tier === 'string' && (SUBSCRIPTION_TIER_ORDER as readonly string[]).includes(tier);
}

/** Returns null for an unknown tier so callers can fail closed. */
export function subscriptionTierRank(tier: unknown): number | null {
  if (!isSubscriptionTier(tier)) return null;
  return SUBSCRIPTION_TIER_ORDER.indexOf(tier);
}

/**
 * Whether a subscriber may use a model with this minimum tier.
 *
 * A missing minimum tier means `free` for backwards-compatible API rows. An
 * unrecognised value is never treated as free: it fails closed instead.
 */
export function subscriptionTierAllows(currentTier: unknown, requiredTier: unknown): boolean {
  const currentRank = subscriptionTierRank(currentTier ?? 'free');
  const requiredRank = subscriptionTierRank(requiredTier ?? 'free');
  return currentRank !== null && requiredRank !== null && currentRank >= requiredRank;
}

export function subscriptionTierLabel(tier: unknown): string | undefined {
  return isSubscriptionTier(tier) ? SUBSCRIPTION_TIER_LABELS[tier] : undefined;
}

/**
 * Plans on sale today, cheapest first. `creator` («Креатор») is the retired
 * pre-2026-07-25 plan: catalogue rows still carry it as `tierMin`, where it
 * means «Плюс and above». Must match the active rows of
 * `packages/db/seed/subscription-catalog.ts` (pinned by a web test).
 */
export const SOLD_SUBSCRIPTION_TIERS = ['start', 'plus', 'pro', 'studio', 'max'] as const;

/**
 * The cheapest plan a customer can actually buy that unlocks a model with this
 * minimum tier — what an upgrade CTA must name. Undefined for an unknown tier.
 */
export function cheapestSoldTierFor(requiredTier: unknown): SubscriptionTier | undefined {
  const required = subscriptionTierRank(requiredTier ?? 'free');
  if (required === null) return undefined;
  return SOLD_SUBSCRIPTION_TIERS.find((tier) => subscriptionTierRank(tier)! >= required);
}
