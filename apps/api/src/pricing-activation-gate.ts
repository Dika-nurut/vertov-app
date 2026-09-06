/**
 * Pure decision logic for `POST /v1/admin/models/:id/price-points/activate`, split
 * out so the money-path gate is unit-testable without a DB/Fastify harness.
 */
import { FALLBACK_MARGIN_FLOOR, PRIMARY_MARGIN_FLOOR } from '@seed/db';

export interface ActivationBlock {
  status: 409;
  error:
    | 'undeliverable_config'
    | 'below_break_even'
    | 'below_margin_floor'
    | 'margin_unverifiable'
    | 'price_not_ssot';
  reason: string;
}

/**
 * Static (model → resolutions) the current route's adapter cannot deliver. This is a
 * hardcoded denylist for the route each listed model is pinned to TODAY (veo is
 * kie-pinned; the kie adapter delivers 720p and 1080p inline on /veo/generate, but 4K
 * — which would need the get-4k-video two-step — is priced but inactive and unwired). It is NOT a
 * live adapter-capability probe: if one of these models is ever rerouted, revisit this
 * list. Kept explicit + narrow, same self-documenting pattern as the break-even
 * quarantine.
 */
export const UNDELIVERABLE_ON_ROUTE: Record<string, readonly string[]> = {
  'veo-3-1': ['4K'],
  'veo-3-1-fast': ['4K'],
  'veo-3-1-lite': ['4K'],
  // Seedance 4K is undeliverable for a different reason than Veo's: the adapter could
  // run it, but only on the WRONG vendor. Finance signs 4K to kie (25.0%); the model row
  // routes to OpenRouter, right for the 1080p it actually sells and a 3.5% LOSS at 4K.
  // The break-even guard does not catch this on its own — with no exact 4K cost it falls
  // back to the model's frozen 1080p reference and reports a comfortable margin that
  // belongs to a different rung. Lift this once the route is rung-aware, not before.
  'seedance-2-0': ['4K'],
  'seedance-2-0-reference-to-video': ['4K'],
};

export interface ActivationInput {
  active: boolean;
  force: boolean;
  modelId: string;
  resolution: string;
  routedFamily: string;
  /** Candidate economics must be a canonical price row before COGS can be trusted. */
  hasCanonicalPrice: boolean;
  hasCostData: boolean;
  margin: number | null;
  floorRub: number;
  /** A submit-time failover leg, if the worker can route this model to one. */
  fallback: {
    gateway: string;
    hasCostData: boolean;
    margin: number | null;
  } | null;
}

/**
 * Returns an {@link ActivationBlock} when the activation must be refused, or `null`
 * when it is allowed. Deactivation (`active:false`) is always allowed; a `force`
 * override bypasses every block (the caller audit-logs it). Otherwise an ACTIVATION
 * is refused when the config is undeliverable on its route, below break-even, or has
 * unverifiable COGS (fail-closed).
 */
export function evaluatePricePointActivation(input: ActivationInput): ActivationBlock | null {
  if (!input.active || input.force) return null;

  if ((UNDELIVERABLE_ON_ROUTE[input.modelId] ?? []).includes(input.resolution)) {
    return {
      status: 409,
      error: 'undeliverable_config',
      reason:
        `${input.modelId} @ ${input.resolution} is not deliverable on its current route ` +
        `(the adapter rejects it) — wire the delivery path or activate a supported resolution.`,
    };
  }

  if (!input.hasCanonicalPrice) {
    return {
      status: 409,
      error: 'price_not_ssot',
      reason:
        `Activating ${input.modelId} @ ${input.resolution} is refused because its price fields do not ` +
        `match the canonical catalogue row. The COGS ladder has no independent economics for an ` +
        `operator-edited SKU; restore the SSOT values or resubmit with force:true + forceReason.`,
    };
  }

  // The floor is 25%, not zero. `margin-floors.ts` calls these constants the policy for
  // "the catalogue guardrails AND admin write gates", and the CI guardrail refuses any
  // seeded primary row below 25% — but this endpoint only ever refused an outright LOSS,
  // so the one path that writes margin policy into a live database was also the one path
  // that did not enforce it. A 23.5% row activated from the panel is invisible to CI,
  // which reads the seed file and not production state.
  //
  // Below zero stays its own answer: selling at a loss is a different decision from
  // selling thin, and the panel's operator needs to be told which one they are making.
  const belowBreakEven = input.hasCostData && input.margin !== null && input.margin < 0;
  const belowFloor =
    input.hasCostData && input.margin !== null && input.margin < PRIMARY_MARGIN_FLOOR;
  const unverifiable = !input.hasCostData || input.margin === null;
  if (belowFloor || unverifiable) {
    const why = unverifiable
      ? `has no frozen COGS reference, so its margin at real routing (${input.routedFamily}) ` +
        `cannot be verified — refusing to activate an unverifiable price`
      : belowBreakEven
        ? `would lose money at real routing (${input.routedFamily}): margin ` +
          `${((input.margin as number) * 100).toFixed(1)}% at the ${input.floorRub.toFixed(3)} ₽/cr floor`
        : `earns ${((input.margin as number) * 100).toFixed(1)}% at real routing ` +
          `(${input.routedFamily}), under the signed ${(PRIMARY_MARGIN_FLOOR * 100).toFixed(0)}% ` +
          `primary floor at the ${input.floorRub.toFixed(3)} ₽/cr floor`;
    return {
      status: 409,
      error: unverifiable
        ? 'margin_unverifiable'
        : belowBreakEven
          ? 'below_break_even'
          : 'below_margin_floor',
      reason:
        `Activating ${input.modelId} @ ${input.resolution} ${why}. Reprice off the routed ` +
        `vendor, pin the cheap vendor via gatewayOverride, or resubmit with force:true + forceReason.`,
    };
  }

  // The reserve keeps the ZERO floor of standing ruling R-1: refusing to fail over turns
  // a vendor outage into ours, and finance prices several reserve legs at break-even on
  // purpose. Thin is the point here; only a loss is forbidden.
  const fallbackBelowBreakEven =
    input.fallback !== null &&
    input.fallback.hasCostData &&
    input.fallback.margin !== null &&
    input.fallback.margin < FALLBACK_MARGIN_FLOOR;
  const fallbackUnverifiable =
    input.fallback !== null && (!input.fallback.hasCostData || input.fallback.margin === null);
  if (fallbackBelowBreakEven || fallbackUnverifiable) {
    const fallback = input.fallback!;
    const why = fallbackUnverifiable
      ? `has no frozen COGS reference for its ${fallback.gateway} fallback, so that failover margin cannot be verified`
      : `would lose money on its ${fallback.gateway} fallback: margin ${(
          (fallback.margin as number) * 100
        ).toFixed(1)}% at the ${input.floorRub.toFixed(3)} ₽/cr floor`;
    return {
      status: 409,
      error: fallbackUnverifiable ? 'margin_unverifiable' : 'below_break_even',
      reason:
        `Activating ${input.modelId} @ ${input.resolution} ${why}. Reprice the fallback leg, ` +
        `remove the fallback, pin a safe route, or resubmit with force:true + forceReason.`,
    };
  }

  return null;
}
