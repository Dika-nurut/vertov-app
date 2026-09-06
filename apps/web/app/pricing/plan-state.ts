// Pure CJM state logic for /pricing — no React, no DOM, no fetch. Every "which
// button, which state" decision lives here so it can be unit-tested as a spec
// (see plan-state.test.ts). The three visitor classes and their plate/pack
// affordances are the whole product surface of this page:
//
//   1. Guest (no session)          → CTAs route to login; packs LOCKED.
//   2. Authed, no active sub       → CTAs subscribe; packs LOCKED.
//   3. Authed, ACTIVE sub          → current tier marked; higher tiers upgrade,
//                                     lower tiers neutral; packs UNLOCKED.

/** What tapping a plate's CTA should do. */
export type PlanAction =
  | 'login'
  | 'subscribe'
  | 'upgrade'
  | 'downgrade'
  | 'cancel-downgrade'
  | 'manage'
  | 'none';

export interface PlanCta {
  /** Button copy. */
  label: string;
  /** Behaviour on click. `none` = inert (disabled). */
  action: PlanAction;
  /** Disabled per press-physics disabled grammar. */
  disabled: boolean;
  /** Lime, non-interactive status marker (this is the viewer's current tier). */
  status?: boolean;
  /** This plate is the scheduled-downgrade target (shows «Запланирован», cancellable). */
  scheduled?: boolean;
}

/** The viewer's relationship to billing, resolved server-side. */
export interface PricingContext {
  /** No session, or an anonymous "Гость" session. */
  guest: boolean;
  /** Active subscription tier, or null if none. */
  activeTier: string | null;
  /** Price snapshot of the active subscription (rub), or null. Used to rank
   *  upgrade vs. downgrade against a plate — works even for a legacy tier
   *  (`creator`) that isn't in the visible grid. */
  activePriceRub: number | null;
  /** Scheduled-downgrade target tier, or null. Applied at the next renewal. */
  pendingTier?: string | null;
  /** A lifecycle row exists, but `planAccess` is absent. */
  planBlocked: boolean;
  /** The authenticated user's subscription lookup did not return a 2xx response. */
  planStateUnknown: boolean;
}

export interface PlateRef {
  tier: string;
  priceRub: number;
}

/**
 * Resolve the CTA for one subscription plate given the viewer context.
 * Higher/lower is decided by price snapshot, so a legacy-tier subscriber
 * (e.g. Креатор) still gets a coherent upgrade/neutral split across the grid.
 */
export function deriveCta(plate: PlateRef, ctx: PricingContext): PlanCta {
  if (ctx.guest) {
    return { label: 'Получить', action: 'login', disabled: false };
  }
  // This account has a subscription row, so subscribing again would 409. The
  // only valid next step is its billing management page.
  if (ctx.planBlocked || ctx.planStateUnknown) {
    return { label: 'Управлять подпиской', action: 'manage', disabled: false };
  }
  // Authed but no active subscription → straight subscribe.
  if (!ctx.activeTier) {
    return { label: 'Получить', action: 'subscribe', disabled: false };
  }
  // Authed WITH an active subscription.
  if (ctx.activeTier === plate.tier) {
    // The viewer's current tier — a lime status marker, not an action.
    return { label: 'Текущий тариф', action: 'none', disabled: true, status: true };
  }
  // A scheduled downgrade lands on THIS plate at the next renewal — show it as
  // scheduled and let the viewer cancel it (checked before price ranking, since
  // the target is by definition cheaper than the current tier).
  if (ctx.pendingTier && ctx.pendingTier === plate.tier) {
    return { label: 'Запланирован', action: 'cancel-downgrade', disabled: false, scheduled: true };
  }
  const activePrice = ctx.activePriceRub ?? 0;
  if (plate.priceRub > activePrice) {
    // Dearer — immediate prorated upgrade.
    return { label: 'Перейти', action: 'upgrade', disabled: false };
  }
  if (plate.priceRub < activePrice) {
    // Cheaper — a scheduled downgrade (confirm step in the UI).
    return { label: 'Перейти', action: 'downgrade', disabled: false };
  }
  // Same price, different tier (shouldn't happen) — neutral.
  return { label: 'Недоступно', action: 'none', disabled: true };
}

/** Разовые пакеты are докупка для подписчиков: only an active subscriber can buy. */
export function arePacksUnlocked(ctx: PricingContext): boolean {
  return !ctx.guest && !ctx.planBlocked && !ctx.planStateUnknown && ctx.activeTier !== null;
}

/**
 * A subscriber whose active tier is not one of the visible grid tiers is on a
 * LEGACY plan (e.g. Креатор). The page shows a compact notice row for them
 * instead of silently marking no plate as current.
 */
export function isLegacyActiveTier(ctx: PricingContext, gridTiers: readonly string[]): boolean {
  return (
    !ctx.guest &&
    !ctx.planBlocked &&
    !ctx.planStateUnknown &&
    ctx.activeTier !== null &&
    !gridTiers.includes(ctx.activeTier)
  );
}

/**
 * The Студия⟷Макс bezel is one plate with two backend tiers. If the viewer's
 * active tier is one of the pair, the knob locks to it (they can't slide to the
 * other and pretend to switch). Returns the tier to lock to, or null if free to
 * drag.
 */
export function bezelLockedTier(
  ctx: PricingContext,
  pair: readonly [string, string],
): string | null {
  if (ctx.guest || ctx.planBlocked || ctx.planStateUnknown || !ctx.activeTier) return null;
  return pair.includes(ctx.activeTier) ? ctx.activeTier : null;
}
