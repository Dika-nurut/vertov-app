import { PRICE_POINT_SEED, type PricePointSeedRow } from '../seed/price-points';
import { costCatalogue } from './cost-catalogue';
import { costLegFile } from './cost-legs-data';
import { splitModelId, type CatalogueEntry } from './price-catalogue';
import {
  workbookCostForPoint,
  workbookEntryForPoint,
  workbookLegForGateway,
  workbookReferencePointForGateway,
} from './workbook-cost-model';

/**
 * Break-even margin of a parametric price point at the gateway the CODE actually
 * routes to. This is the SINGLE source of the money-path margin math: the CI guard
 * (packages/db/__tests__/cogs-breakeven.test.ts) and the runtime activation gate
 * (apps/api /v1/admin/models/:id/price-points/activate) both import it, so a row
 * can never pass one and fail the other.
 *
 * Founder floor semantics: break-even (margin >= 0) at the routed leg, at the
 * cheapest credit rate any subscriber can obtain. COGS is read from the generated
 * workbook export (`cost-legs.csv`) at the exact price-point rung; the historical
 * `pricing-ladder-v3.json` is not a money-path input.
 */

export type GatewayFamily = 'openrouter' | 'direct';

/**
 * The finance-frozen landed ₽ per $1 of vendor spend, by payment channel — CBR
 * rate × top-up × corridor × agent VAT, not a bare FX quote. The only financial
 * source for this pair is the signed v14 workbook export (106.182 / 100.6315,
 * replacing 95.5567 / 90.5751 off the retired 76.5 basis), and every
 * copy that did not move computes a margin ~11% too flattering. Exported so a
 * consumer cites this instead of re-typing the numbers.
 */
/** Finance workbook landed FX. The values are asserted against the export in the
 * workbook SSOT guard; this package cannot import the XLSX at runtime. */
const landedFxFromExport = (relay: string): number => {
  const leg = costLegFile.legs.find((candidate) => candidate.relay.toLowerCase() === relay);
  if (!leg) throw new Error(`price-breakeven: workbook export has no ${relay} FX leg`);
  return leg.landedRubPerUnit;
};

export const GATEWAY_FX_RUB = {
  openrouter: landedFxFromExport('openrouter'),
  direct: landedFxFromExport('kie'),
} as const;

/** Model routing/cost facts this math needs — satisfied by both a seed row and a
 *  live DB `models` row (same field names). */
export interface BreakEvenModel {
  id: string;
  gatewayOverride?: string | null;
  /** Admin-configured failover gateway (`models.fallback_gateway`). */
  fallbackGateway?: string | null;
  /** Vendor output-duration clamp, used by the sellable-duration guard. */
  maxDurationSeconds?: number | null;
  providerModelId: string;
  capabilities?: unknown;
  /**
   * Ephemeral, exact reference-leg costs supplied by the admin gateway guard.
   * A present map is strict: a missing key means the gateway is uncosted. It
   * is intentionally not a database column; the source is the model's current
   * audited routing state. The workbook resolver below is the financial source
   * of truth; this map remains for the legacy route-guard API shape.
   */
  gatewayCostPerCredit?: Readonly<Record<string, number | null>>;
}

function signedChainFallback(model: BreakEvenModel): string | null {
  const key = realGateway(model);
  if (key !== 'nanobanana' && key !== 'geminiomni') return null;
  const point = workbookReferencePointForGateway(model.id, key);
  if (point) {
    const entry = workbookEntryForPoint(point);
    const primary = entry ? workbookLegForGateway(entry, key) : null;
    const next = primary && entry?.legs.find((leg) => leg.leg > primary.leg);
    if (next) return next.relay.trim().toLowerCase();
  }
  // A provider chain can still execute an unpriced relay even when finance has
  // signed only one leg. Keep that relay visible as `uncosted` instead of
  // silently treating the chain as single-leg.
  return key === 'nanobanana' ? 'kie' : 'atlascloud';
}

/**
 * The gateway a real job falls over to when the primary leg's `generate()`
 * throws. Two sources, in production precedence:
 *
 *  1. `models.fallback_gateway` — the admin-configured pair the worker wraps in
 *     a `CircuitBreakerAdapter` (apps/worker/src/job-runner.ts:143-154 →
 *     `getAdapterWithFallback`).
 *  2. the chain BUILT IN to a multi-leg gateway key, for the two families whose
 *     "gateway" is really a vendor chain
 *     (packages/providers/byteplus/src/index.ts):
 *       `nanobanana` = laozhang → **kie** → official OpenRouter
 *       `geminiomni` = kie → **atlascloud** → official OpenRouter
 *     The 3rd (official-OpenRouter) leg is still NOT modelled here, and that is
 *     now a deliberate boundary rather than a gap: since 2026-08-02 it is not a
 *     priced route at all but capped insurance. A row reaches it only by opting
 *     in (`capabilities.openrouterFallbackSlug`) AND carrying a per-rung rate
 *     (`capabilities.officialUsdPerUnit`) — today that is `gemini-3-pro-image`
 *     at 4K alone — and its accumulated loss is metered against finance's
 *     3 000 ₽/day + 20 000 ₽/month cap (`src/official-leg-budget.ts`). Scoring
 *     it as a margin here would imply we intend to sell on it; we do not.
 *
 * Failover only fires BEFORE a durable handle is obtained
 * (`circuit-breaker-adapter.ts:23-33`), so this is submit-time exposure.
 */
export function fallbackGatewayOf(model: BreakEvenModel): string | null {
  if (model.fallbackGateway) return model.fallbackGateway.toLowerCase();
  return signedChainFallback(model);
}

function fallbackGatewayForPoint(
  model: BreakEvenModel,
  point: PricePointForBreakEven,
): string | null {
  if (model.fallbackGateway) return model.fallbackGateway.toLowerCase();
  const key = realGateway(model);
  if (key !== 'nanobanana' && key !== 'geminiomni') return null;
  const entry = workbookEntryForPoint({
    modelId: point.modelId,
    resolution: point.resolution,
    videoInput: point.videoInput,
    audio: point.audio,
    mode: (point.mode ?? 'any') as PricePointSeedRow['mode'],
    refsMin: point.refsMin ?? 0,
    refsMax: point.refsMax ?? null,
  });
  const primary = entry ? workbookLegForGateway(entry, key) : null;
  const next = primary && entry?.legs.find((leg) => leg.leg > primary.leg);
  return next?.relay.trim().toLowerCase() ?? signedChainFallback(model);
}

/** Only the literal `openrouter*` gateway bills at the dear OR FX; every other
 *  gateway (kie / nanobanana / geminiomni / atlascloud) is direct FX — matches
 *  apps/api/src/admin-panel.ts channel classification. */
export const gatewayFamilyOf = (gateway: string): GatewayFamily =>
  gateway.toLowerCase().startsWith('openrouter') ? 'openrouter' : 'direct';

/** Cheapest ₽-per-credit across ALL tiers (incl. a deactivated legacy plan that
 *  existing subscribers still spend at) — the safe revenue floor. Same derivation
 *  as the OpenRouter margin guardrail. */
export function creditFloorRub(
  tiers: ReadonlyArray<{ priceRub: number; creditsPerCycle: number }>,
): number {
  const rates = tiers
    .filter((tier) => Number.isFinite(tier.priceRub) && tier.priceRub > 0)
    .filter((tier) => Number.isFinite(tier.creditsPerCycle) && tier.creditsPerCycle > 0)
    .map((tier) => tier.priceRub / tier.creditsPerCycle);
  return rates.length ? Math.min(...rates) : 0;
}

/** The gateway KEY a real job for `model` hits — mirrors the production routing
 *  precedence in apps/api/src/jobs-routes.ts EXACTLY: gatewayOverride (admin pin) →
 *  slash-shaped providerModelId forces OpenRouter → capabilities.forceGateway.
 *  `''` = no pin and no slash: the per-job default gateway, not statically knowable. */
export function realGateway(model: BreakEvenModel): string {
  if (model.gatewayOverride) return model.gatewayOverride.toLowerCase();
  if (model.providerModelId.includes('/')) return 'openrouter';
  const forced = (model.capabilities as { forceGateway?: string } | null | undefined)?.forceGateway;
  return forced ? forced.toLowerCase() : '';
}

/** The vendor family a real job for `model` hits. */
export function realGatewayFamily(model: BreakEvenModel): GatewayFamily {
  const key = realGateway(model);
  // No pin, no slash: treat the per-job default as direct (the cheap default) —
  // callers that need certainty pin the gateway.
  return key ? gatewayFamilyOf(key) : 'direct';
}

/** Exact workbook cost of a price point at a named gateway. */
function workbookPointCostPerCredit(point: PricePointForBreakEven, gateway: string): number | null {
  const cost = workbookCostForPoint(
    {
      modelId: point.modelId,
      resolution: point.resolution,
      videoInput: point.videoInput,
      audio: point.audio,
      mode: (point.mode ?? 'any') as PricePointSeedRow['mode'],
      refsMin: point.refsMin ?? 0,
      refsMax: point.refsMax ?? null,
      baseUnits: point.baseUnits,
      flatRate: point.flatRate ?? false,
    },
    gateway,
  );
  if (
    !cost ||
    !Number.isFinite(point.baseCredits) ||
    point.baseCredits <= 0 ||
    cost.entry.credits !== point.baseCredits ||
    cost.entry.baseUnits !== point.baseUnits
  ) {
    return null;
  }
  return cost.costRub / point.baseCredits;
}

function workbookModelReference(
  modelId: string,
  gateway: string,
): { costPerCredit: number; point: PricePointSeedRow } | null {
  const point = workbookReferencePointForGateway(modelId, gateway);
  if (!point) return null;
  const cost = workbookCostForPoint(point, gateway);
  if (
    !cost ||
    !Number.isFinite(point.baseCredits) ||
    point.baseCredits <= 0 ||
    cost.entry.credits !== point.baseCredits ||
    cost.entry.baseUnits !== point.baseUnits
  ) {
    return null;
  }
  return { costPerCredit: cost.costRub / point.baseCredits, point };
}

/** Workbook-derived model reference cost. */
function workbookModelCostPerCredit(model: BreakEvenModel, gateway: string): number | null {
  const resolved = workbookModelReference(model.id, gateway);
  return resolved?.costPerCredit ?? null;
}

/** One leg of a model's routing chain, priced. */
export interface BreakEvenLeg {
  /** Gateway key — 'kie', 'openrouter', 'atlascloud', … */
  gateway: string;
  family: GatewayFamily;
  /** null when no COGS figure exists for this leg — UNCOSTED, never free. */
  costPerCredit: number | null;
  margin: number | null;
}

export interface BreakEvenResult {
  /** false when the model has no signed workbook COGS reference row (margin unknown). */
  hasCostData: boolean;
  /** margin = 1 − routedCostPerCredit / floor; negative = below break-even. */
  margin: number | null;
  routedCostPerCredit: number | null;
  routedGateway: string;
  routedFamily: GatewayFamily;
  /**
   * The leg a submit-time primary failure hands the job to, priced from a
   * signed workbook relay. `null` when the model has no fallback leg
   * at all; a leg with `costPerCredit: null` HAS a fallback we cannot price yet.
   * Falling back must not push a model under water — so this is checked, not
   * assumed (packages/db/__tests__/model-margin-guardrail.test.ts).
   */
  fallback: BreakEvenLeg | null;
}

/** The immutable economics of one candidate `model_price_points` row. */
export interface PricePointForBreakEven {
  modelId: string;
  resolution: string;
  videoInput: boolean;
  audio: boolean;
  unitKind: string;
  baseCredits: number;
  baseUnits: number;
  /**
   * One charge for the whole job (`model_price_points.flat_rate`). Optional so an
   * older caller still compiles, and DEFAULTS TO FALSE — which is the safe side: a
   * flat row costed as if it were per-second reads too PROFITABLE, never too poor,
   * so an omission cannot hide a loss from the guard by accident. It hid one by
   * accident anyway, which is why it is now a field rather than an assumption.
   */
  flatRate?: boolean;
  /**
   * The two dimensions the widened price key adds. Optional for the same reason
   * `flatRate` is — an older caller still compiles — and defaulting to the values
   * every pre-key row carries: `'any'`, band 0..∞.
   *
   * They are part of a row's IDENTITY, not decoration: two rows can now agree on all
   * four legacy columns and still be different prices, so a canonicity check that
   * ignored them would accept an operator-invented i2v row because its t2v twin is
   * seeded.
   */
  mode?: string;
  refsMin?: number;
  refsMax?: number | null;
  /**
   * Nullable because the COLUMN is (`model_price_points.source_ref`). A row with
   * no provenance cannot match a seeded row, so it fails the SSOT check — which
   * is the direction we want: an operator-invented row is exactly what the
   * activation gate must refuse.
   */
  sourceRef: string | null;
}

/**
 * An operator may toggle a canonical row, but cannot turn an ad-hoc edited
 * price into a sellable SKU. The historical ladder is audit context only; the
 * workbook-derived catalogue carries the independent COGS for this calculation.
 */
export function matchesPricePointSeed(point: PricePointForBreakEven): boolean {
  return PRICE_POINT_SEED.some(
    (seed) =>
      seed.modelId === point.modelId &&
      seed.resolution === point.resolution &&
      seed.videoInput === point.videoInput &&
      seed.audio === point.audio &&
      seed.unitKind === point.unitKind &&
      seed.baseCredits === point.baseCredits &&
      seed.baseUnits === point.baseUnits &&
      seed.mode === (point.mode ?? 'any') &&
      seed.refsMin === (point.refsMin ?? 0) &&
      seed.refsMax === (point.refsMax ?? null) &&
      seed.sourceRef === point.sourceRef,
  );
}

/**
 * Resolve the v2 cost entry for a reference band. The seeded price rows use
 * `mode: 'any'`, so the band mode is derived from the reference bounds instead
 * of trusting that legacy-facing field.
 */
function v2BandEntry(point: PricePointForBreakEven): CatalogueEntry | null {
  const refsMin = point.refsMin ?? 0;
  const refsMax = point.refsMax;
  if (!Number.isFinite(refsMin) || refsMin <= 0) return null;
  if (typeof refsMax !== 'number' || !Number.isFinite(refsMax)) return null;
  if (refsMax < refsMin) return null;
  const mode = `refs-${refsMin}-${refsMax}`;
  const modelId = splitModelId(point.modelId).modelId;
  return (
    costCatalogue().find(
      (entry) =>
        entry.modelId === modelId &&
        entry.rung === point.resolution &&
        entry.mode === mode &&
        entry.audio === null &&
        entry.quality === null,
    ) ?? null
  );
}

/** Cost one v2 band at its signed ceiling for one routed adapter gateway. */
function v2BandCostRub(point: PricePointForBreakEven, gateway: string): number | null {
  if (
    !Number.isFinite(point.baseCredits) ||
    point.baseCredits <= 0 ||
    !Number.isFinite(point.baseUnits) ||
    point.baseUnits <= 0 ||
    point.videoInput ||
    point.unitKind !== 'image'
  ) {
    return null;
  }
  const cost = workbookCostForPoint(
    {
      modelId: point.modelId,
      resolution: point.resolution,
      videoInput: point.videoInput,
      audio: point.audio,
      mode: (point.mode ?? 'any') as PricePointSeedRow['mode'],
      refsMin: point.refsMin ?? 0,
      refsMax: point.refsMax ?? null,
      baseUnits: point.baseUnits,
      flatRate: point.flatRate ?? false,
    },
    gateway,
  );
  if (
    !cost ||
    cost.entry.credits !== point.baseCredits ||
    cost.entry.baseUnits !== point.baseUnits
  ) {
    return null;
  }
  return cost.costRub;
}

/**
 * The v2 band branch intentionally has no legacy lookup or legacy normalization
 * in its call path. It is used before `pricePointBreakEven` resolves the
 * workbook-derived reference row.
 */
function pricePointBreakEvenV2Band(
  model: BreakEvenModel,
  floorRub: number,
  point: PricePointForBreakEven,
): BreakEvenResult {
  const routedGateway = realGateway(model);
  const routedFamily = realGatewayFamily(model);
  const fallbackGateway = fallbackGatewayForPoint(model, point);
  const revenueRub = point.baseCredits * floorRub;

  const marginFor = (gateway: string): { margin: number | null; cost: number | null } => {
    if (!Number.isFinite(floorRub) || floorRub <= 0 || !Number.isFinite(revenueRub)) {
      return { margin: null, cost: null };
    }
    const cost = v2BandCostRub(point, gateway);
    return { margin: cost === null ? null : 1 - cost / revenueRub, cost };
  };

  const routed = marginFor(routedGateway);
  const fallbackCost = fallbackGateway ? marginFor(fallbackGateway) : null;
  const entry = v2BandEntry(point);
  return {
    hasCostData: entry !== null && routed.margin !== null,
    margin: routed.margin,
    routedCostPerCredit: routed.cost === null ? null : routed.cost / point.baseCredits,
    routedGateway,
    routedFamily,
    fallback: fallbackGateway
      ? {
          gateway: fallbackGateway,
          family: gatewayFamilyOf(fallbackGateway),
          costPerCredit:
            fallbackCost?.cost === null || fallbackCost?.cost === undefined
              ? null
              : fallbackCost.cost / point.baseCredits,
          margin: fallbackCost?.margin ?? null,
        }
      : null,
  };
}

/**
 * Break-even for the candidate price row itself, not the model's reference
 * rung. Its revenue comes from this row's `baseCredits`/`baseUnits`; primary
 * and fallback COGS are scaled to that same sellable quantity.
 */
export function pricePointBreakEven(
  model: BreakEvenModel,
  floorRub: number,
  point: PricePointForBreakEven,
): BreakEvenResult {
  // Reference bands are v2-only economics. This branch must precede modelBreakEven
  // and the legacy matrix lookup: creditsBaseConfig, refClipSeconds and the
  // legacy matrix rate are not valid inputs for a band.
  if ((point.refsMin ?? 0) > 0) {
    return pricePointBreakEvenV2Band(model, floorRub, point);
  }
  const routedGateway = realGateway(model);
  const routedFamily = realGatewayFamily(model);
  const fallbackGateway = fallbackGatewayForPoint(model, point);
  const marginFor = (gateway: string): { margin: number | null; cost: number | null } => {
    if (!Number.isFinite(floorRub) || floorRub <= 0) return { margin: null, cost: null };
    const cost = workbookPointCostPerCredit(point, gateway);
    if (cost === null) return { margin: null, cost: null };
    return { margin: 1 - cost / floorRub, cost };
  };
  const routed = marginFor(routedGateway);
  const fallback = fallbackGateway
    ? (() => {
        const scored = marginFor(fallbackGateway);
        return {
          gateway: fallbackGateway,
          family: gatewayFamilyOf(fallbackGateway),
          costPerCredit: scored.cost,
          margin: scored.margin,
        };
      })()
    : null;
  return {
    hasCostData: routed.margin !== null,
    margin: routed.margin,
    routedCostPerCredit: routed.cost,
    routedGateway,
    routedFamily,
    fallback,
  };
}

/**
 * Margin for one SELLABLE video duration at the model's real primary route.
 *
 * `chargedCredits` must come from the parametric price row's rational formula
 * for this exact duration. Most vendors charge per output second, so COGS grows
 * with duration. Veo is the explicit v14 exception: it bills us per clip, so
 * its 4 s sell rung bears the full reference-clip COGS.
 */
export function videoDurationMargin(
  model: BreakEvenModel,
  floorRub: number,
  durationSeconds: number,
  chargedCredits: number,
): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  if (!Number.isFinite(chargedCredits) || chargedCredits <= 0) return null;

  const referencePoint = workbookReferencePointForGateway(model.id, realGateway(model));
  if (!referencePoint) return null;
  const referenceCost = workbookCostForPoint(referencePoint, realGateway(model));
  if (!referenceCost) return null;
  const costRub = referencePoint.flatRate
    ? referenceCost.costRub
    : referenceCost.costRub * (durationSeconds / referencePoint.baseUnits);
  return 1 - costRub / (chargedCredits * floorRub);
}

/** Compute a model's reference-config margin at its real routing and the given
 *  revenue floor. `hasCostData:false` when no signed workbook COGS row exists
 *  for the model. */
export function modelBreakEven(model: BreakEvenModel, floorRub: number): BreakEvenResult {
  const routedGateway = realGateway(model);
  const routedFamily = realGatewayFamily(model);
  const fallbackGateway = fallbackGatewayOf(model);
  const routedReference = workbookModelCostPerCredit(model, routedGateway);
  if (routedReference === null) {
    return {
      hasCostData: false,
      margin: null,
      routedCostPerCredit: null,
      routedGateway,
      routedFamily,
      fallback: fallbackGateway
        ? {
            gateway: fallbackGateway,
            family: gatewayFamilyOf(fallbackGateway),
            costPerCredit: null,
            margin: null,
          }
        : null,
    };
  }
  const cost = routedReference;
  let fallback: BreakEvenLeg | null = null;
  if (fallbackGateway) {
    const family = gatewayFamilyOf(fallbackGateway);
    const costPerCredit = workbookModelCostPerCredit(model, fallbackGateway);
    fallback = {
      gateway: fallbackGateway,
      family,
      costPerCredit,
      margin: costPerCredit === null ? null : 1 - costPerCredit / floorRub,
    };
  }
  return {
    hasCostData: cost !== null,
    margin: cost === null ? null : 1 - cost / floorRub,
    routedCostPerCredit: cost,
    routedGateway,
    routedFamily,
    fallback,
  };
}
