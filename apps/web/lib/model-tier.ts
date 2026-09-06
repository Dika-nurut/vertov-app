/**
 * Plan entitlement (P-B2 / DEC-3) — the ONE ranking every surface gates its
 * model picker with. A catalog row carries `tierMin`; the user's plan tier must
 * rank at or above it. Guests and non-subscribers are 'free'.
 *
 * Extracted from GenerateClient so /generate and /boards cannot drift: the
 * board picker used to show every model as freely selectable and the user only
 * hit the wall at submit (403 toast). The server-side check in
 * `apps/api/src/jobs-routes.ts` stays the last line of defence — nothing here
 * replaces it.
 *
 * The ORDER itself deliberately lives in `@seed/shared/subscription-tiers`,
 * which `jobs-routes.ts` also gates on: this module is UI presentation on top of
 * that single source of truth, never a second copy of it. A local rank table
 * here silently ranked `plus`/`pro`/`studio`/`max` as `free` — anyone above
 * Креатор, including every god-mode account, would have seen the whole catalog
 * locked.
 */
import {
  SUBSCRIPTION_TIER_LABELS,
  subscriptionTierAllows,
  subscriptionTierRank,
  type SubscriptionTier,
} from '@seed/shared/subscription-tiers';

export type PlanTier = SubscriptionTier;

/** Russian plan names — used by the upsell CTA on both surfaces. */
export const TIER_LABEL: Readonly<Record<string, string>> = SUBSCRIPTION_TIER_LABELS;

/** The only shape entitlement depends on. */
export interface TierGatedModel {
  tierMin?: string | null;
}

/**
 * Sort/compare helper for pickers. Unknown tiers fail CLOSED (ranked above the
 * top plan) so an unrecognised `tierMin` is never silently treated as free.
 */
export function tierRank(tier?: string | null): number {
  return subscriptionTierRank(tier ?? 'free') ?? Number.MAX_SAFE_INTEGER;
}

/** True when the plan does NOT entitle this model — show it locked + upsell. */
export function isModelLocked(model: TierGatedModel, userTier?: string | null): boolean {
  return !subscriptionTierAllows(userTier ?? 'free', model.tierMin ?? 'free');
}

/** «Открыть в тарифе «Креатор»» — the shared upsell copy. */
export function tierUpsellLabel(model: TierGatedModel | null | undefined): string {
  return `Открыть в тарифе «${TIER_LABEL[model?.tierMin ?? 'creator'] ?? 'Креатор'}»`;
}
