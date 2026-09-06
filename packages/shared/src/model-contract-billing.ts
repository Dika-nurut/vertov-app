/**
 * The BILLABLE selector, derived from the normalized (SERVED) parameters (execution
 * plan DoD 3: "the parameter selector used to PRICE the job is byte-identical to the
 * selector serialized to the provider"). It computes billable units by calling the
 * SAME `normalizeVideoParams` the adapter serializer will call, so the price side and
 * the wire side share one rounding/snap/floor path.
 *
 * SCOPE of the guarantee this establishes TODAY: billed == served at the SELECTOR
 * level — pricing and serialization, both derived from this function, cannot diverge.
 * It does NOT yet prove the adapter body agrees, because the adapters still compute
 * their own values — though they now compute the SAME value (every kie duration
 * serializer uses Math.ceil since 9f2d4c1, matching this function); full parity becomes
 * real only once the adapters literally call normalizeVideoParams and an adapter-body
 * assertion pins it (Phase 4 wiring). It also prices the PRIMARY route
 * only — a failover that serves fewer seconds is a route-aware reconciliation concern
 * (Phase 3/5), so a primary-route bill is a provisional quote, not a post-failover
 * settlement. This module + its invariant test land first so the pricing side is ready
 * and the selector-level guarantee is provable before the switch-over.
 */

import {
  normalizeVideoParams,
  type ModelGatewayContract,
  type ContractRole,
} from './model-contract';

export type BillableVideoResult = { ok: true; units: number } | { ok: false; error: string };

/**
 * Billable video units for ONE route contract. The billable unit is the selector's
 * normalized duration — the seconds the wire side sends once the adapter derives from
 * the same normalizer. A request the route would REJECT is not billable, and neither
 * is a video request with NO explicit duration: billing must never invent a duration
 * (unlike the serializer, which may fall back to the contract default). This mirrors
 * unitsForGenerationModel — a video charge requires a finite, positive duration.
 */
export function billableVideoUnits(
  contract: ModelGatewayContract,
  params: Record<string, unknown>,
): BillableVideoResult {
  // Duration is required for a video charge — reject absent / non-finite / ≤0
  // (including the -1 "model decides" sentinel) rather than bill a default.
  if (contract.duration) {
    const raw = Number(params['duration_seconds']);
    if (!Number.isFinite(raw) || raw <= 0) {
      return { ok: false, error: 'duration_seconds_required' };
    }
  }
  const served = normalizeVideoParams(contract, params);
  if (!served.ok) return { ok: false, error: served.error };
  if (served.value.duration === undefined) {
    return { ok: false, error: 'contract has no duration to bill' };
  }
  return { ok: true, units: served.value.duration };
}

/**
 * Bill a MODEL from the route that will actually serve the job: the PRIMARY. A
 * failover to a fallback route may serve fewer seconds (a snapping OpenRouter leg)
 * or reject a conditioned job — that cross-route downgrade is the route-aware
 * contract's concern (Phase 3/5), NOT a reason to bill the primary differently. On
 * the primary path, billed == served holds unconditionally.
 */
export function billableVideoUnitsForModel(
  contracts: readonly ModelGatewayContract[],
  params: Record<string, unknown>,
): BillableVideoResult {
  const roleRank = (r: ContractRole) => (r === 'primary' ? 0 : 1);
  const primary = [...contracts].sort((a, b) => roleRank(a.role) - roleRank(b.role))[0];
  if (!primary) return { ok: false, error: 'no contract for model' };
  return billableVideoUnits(primary, params);
}
