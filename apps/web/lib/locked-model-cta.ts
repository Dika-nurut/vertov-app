/**
 * Where the locked-model upsell points (W0 / D6, owner ruling 2026-07-28).
 *
 * /generate and /boards both swap the run button for an upsell when the picked
 * model is above the plan. Since W0 gates that on the LIVE subscription, an
 * elapsed subscriber now sees every paid model locked — and /pricing is the one
 * place they must not be sent: its CTA is computed from the manageable (elapsed)
 * row, while the API deliberately refuses an upgrade against an expired period.
 *
 * /settings/billing is the destination for the recovery state: cancelling an
 * elapsed subscription closes it immediately, after which the customer can
 * subscribe again. Nothing about billing changes here — only where the link
 * goes. Someone who never subscribed still goes to /pricing.
 */
export interface PlanAccessCtaState {
  /** A subscription is entitling models right now (`planAccess !== null`). */
  hasLivePlan: boolean;
  /** A manageable subscription row exists — i.e. the endpoint returned a row,
   *  live or elapsed. A failed fetch counts as "no row" and keeps today's
   *  /pricing behaviour. */
  hasManageableSubscription: boolean;
}

export function lockedModelCtaHref(state: PlanAccessCtaState): string {
  return !state.hasLivePlan && state.hasManageableSubscription ? '/settings/billing' : '/pricing';
}
