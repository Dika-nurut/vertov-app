import {
  FALLBACK_MARGIN_FLOOR,
  PRIMARY_MARGIN_FLOOR,
  fallbackGatewayOf,
  modelBreakEven,
  pricePointBreakEven,
  realGateway,
  splitModelId,
  usdAtReferenceCount,
  type BreakEvenModel,
  type CatalogueEntry,
  type PricePointForBreakEven,
} from '@seed/db';
import { OFFICIAL_LEG_GATEWAY, officialLegServability } from '@seed/shared/official-leg-cost';
import {
  isGatewayArmed,
  isSingleLegConfiguration,
  signedChainLegOrder,
  type GatewayArming,
} from '@seed/shared';

export type GatewayMarginLeg = 'primary' | 'fallback' | 'last-resort';
export type GatewayMarginGovernance = 'margin_floor' | 'spend_cap';
export type GatewayMarginReason = 'below_floor' | 'uncosted' | 'no_active_price_points';

export interface GatewayMarginExecutableLeg {
  gateway: string;
  leg: GatewayMarginLeg;
  governance: GatewayMarginGovernance;
}

export interface GatewayMarginIssue {
  rung: {
    resolution: string;
    videoInput: boolean;
    audio: boolean;
    baseCredits: number;
    baseUnits: number;
    sourceRef: string | null;
  } | null;
  leg: GatewayMarginLeg;
  gateway: string;
  reason: GatewayMarginReason;
  marginPct: number | null;
  floorPct: number;
  shortfallPct: number | null;
}

export interface GatewayChangeInput {
  before: BreakEvenModel;
  after: BreakEvenModel;
  floorRub: number;
  pricePoints: readonly PricePointForBreakEven[];
  /** Phase 3a source of truth; absent only for legacy unit callers/tests. */
  v2Catalogue?: readonly CatalogueEntry[];
  /** Live leaf arming used when the v2 catalogue path expands a built-in chain. */
  gatewayArming?: GatewayArming;
}

function sameExecutableLegs(before: BreakEvenModel, after: BreakEvenModel): boolean {
  return (
    realGateway(before) === realGateway(after) &&
    fallbackGatewayOf(before) === fallbackGatewayOf(after)
  );
}

function rungOf(point: PricePointForBreakEven): GatewayMarginIssue['rung'] {
  return {
    resolution: point.resolution,
    videoInput: point.videoInput,
    audio: point.audio,
    baseCredits: point.baseCredits,
    baseUnits: point.baseUnits,
    sourceRef: point.sourceRef,
  };
}

function issueFor(
  point: PricePointForBreakEven,
  leg: GatewayMarginLeg,
  gateway: string,
  margin: number | null,
  floor: number,
): GatewayMarginIssue | null {
  if (margin !== null && margin >= floor) return null;
  const shortfallPct = margin === null ? null : (floor - margin) * 100;
  return {
    rung: rungOf(point),
    leg,
    gateway: gateway || 'unresolved',
    reason: margin === null ? 'uncosted' : 'below_floor',
    marginPct: margin === null ? null : margin * 100,
    floorPct: floor * 100,
    shortfallPct,
  };
}

/** Leaves implicit in the two gateway aliases that build a chain in the
 * provider package. They are executable even when models.fallback_gateway is
 * set to a different outer fallback. The official tail is budget-governed
 * insurance; the relay tail remains subject to the ordinary fallback floor. */
function builtInChainLegs(gateway: string): GatewayMarginExecutableLeg[] {
  if (gateway === 'nanobanana') {
    // `SIGNED_CHAIN_LEG_ORDER` can swap which relay serves first (kie at
    // gemini-3-1-flash-image 1K, laozhang at 2K/4K), but it only ever REORDERS legs the
    // chain already builds — the executable SET is {laozhang, kie} on every rung, which
    // is what this enumeration is for. The alias contributes the serving leaf and this
    // contributes the other one, so coverage is unaffected by the order. What DOES move
    // with the order is which leaf the alias is PRICED as; that is handled in
    // `v2MarginForRoute`, and which relay is the OTHER one, handled in `v2Routes`.
    return [
      { gateway: 'kie', leg: 'fallback', governance: 'margin_floor' },
      { gateway: OFFICIAL_LEG_GATEWAY, leg: 'last-resort', governance: 'spend_cap' },
    ];
  }
  if (gateway === 'geminiomni') {
    return [
      { gateway: 'atlascloud', leg: 'fallback', governance: 'margin_floor' },
      { gateway: OFFICIAL_LEG_GATEWAY, leg: 'last-resort', governance: 'spend_cap' },
    ];
  }
  return [];
}

function configuredFallbackOf(model: BreakEvenModel): string | null {
  return model.fallbackGateway?.toLowerCase() || null;
}

function nestedChainLegs(model: BreakEvenModel): GatewayMarginExecutableLeg[] {
  const primary = realGateway(model);
  const fallback = configuredFallbackOf(model);
  return [
    ...(primary ? builtInChainLegs(primary) : []),
    ...(fallback && fallback !== primary ? builtInChainLegs(fallback) : []),
  ];
}

/** Enumerate every top-level and built-in chain leg in runtime order. */
export function enumerateExecutableLegs(model: BreakEvenModel): GatewayMarginExecutableLeg[] {
  const primary = realGateway(model) || 'unresolved';
  const fallback = configuredFallbackOf(model);
  return [
    { gateway: primary, leg: 'primary' as const, governance: 'margin_floor' as const },
    ...(fallback && fallback !== primary
      ? [{ gateway: fallback, leg: 'fallback' as const, governance: 'margin_floor' as const }]
      : []),
    ...nestedChainLegs(model),
  ];
}

function noActivePricePointsIssue(model: BreakEvenModel): GatewayMarginIssue {
  return {
    rung: null,
    leg: 'primary',
    gateway: realGateway(model) || 'unresolved',
    reason: 'no_active_price_points',
    marginPct: null,
    floorPct: PRIMARY_MARGIN_FLOOR * 100,
    shortfallPct: null,
  };
}

/**
 * Is the official leg exempt from the ordinary fallback floor on this rung?
 *
 * Only when it can ACTUALLY EXECUTE there, which is the same question
 * `OfficialOpenRouterFallbackAdapter` asks before it submits — so both sides
 * read the one predicate in `@seed/shared`. "The spend cap governs this leg"
 * only excuses a margin the leg will really earn; the adapter refuses every
 * VIDEO rung before it consults a cost (billed per output second, rung map per
 * unit), and this gate used to exempt a costed video rung anyway. Latent so far
 * — no video row carries an official slug — but it is the panel blessing a leg
 * the worker would refuse, which is exactly how the leg armed itself last time.
 */
function isCostedOfficialInsuranceLeg(
  model: BreakEvenModel,
  point: PricePointForBreakEven,
): boolean {
  return officialLegServability(
    model.capabilities,
    { resolution: point.resolution },
    point.unitKind === 'second' ? 'video' : 'image',
  ).servable;
}

/**
 * Score the candidate routing on every active price rung. The reference
 * model's known primary/fallback costs are carried forward only when the
 * candidate still selects that exact gateway. A newly selected gateway gets no
 * implicit credit for sharing an FX family: absent an exact ladder row it is
 * represented as `null` and becomes an override-required refusal.
 */
export function inspectGatewayChange(input: GatewayChangeInput): GatewayMarginIssue[] {
  if (input.v2Catalogue) return inspectGatewayChangeV2(input);
  if (sameExecutableLegs(input.before, input.after)) return [];
  if (input.pricePoints.length === 0) return [noActivePricePointsIssue(input.after)];

  const beforeResult = modelBreakEven(input.before, input.floorRub);
  const gatewayCostPerCredit: Record<string, number | null> = {};
  const beforePrimary = realGateway(input.before);
  gatewayCostPerCredit[beforePrimary] = beforePrimary ? beforeResult.routedCostPerCredit : null;
  if (beforeResult.fallback) {
    gatewayCostPerCredit[beforeResult.fallback.gateway] = beforeResult.fallback.costPerCredit;
  }

  const afterPrimary = realGateway(input.after);
  if (!Object.prototype.hasOwnProperty.call(gatewayCostPerCredit, afterPrimary)) {
    gatewayCostPerCredit[afterPrimary] = null;
  }
  const afterFallback = fallbackGatewayOf(input.after);
  if (afterFallback && !Object.prototype.hasOwnProperty.call(gatewayCostPerCredit, afterFallback)) {
    gatewayCostPerCredit[afterFallback] = null;
  }

  const candidate = { ...input.after, gatewayCostPerCredit };
  const issues: GatewayMarginIssue[] = [];
  for (const point of input.pricePoints) {
    const result = pricePointBreakEven(candidate, input.floorRub, point);
    const primaryIssue = issueFor(
      point,
      'primary',
      afterPrimary,
      result.margin,
      PRIMARY_MARGIN_FLOOR,
    );
    if (primaryIssue) issues.push(primaryIssue);

    if (result.fallback) {
      const fallbackIssue = issueFor(
        point,
        'fallback',
        result.fallback.gateway,
        result.fallback.margin,
        FALLBACK_MARGIN_FLOOR,
      );
      if (fallbackIssue) issues.push(fallbackIssue);
    }

    const represented = new Set(
      [afterPrimary, afterFallback].filter((gateway): gateway is string => Boolean(gateway)),
    );
    const inspectedChainGateways = new Set<string>();
    for (const chainLeg of nestedChainLegs(input.after)) {
      if (represented.has(chainLeg.gateway) || inspectedChainGateways.has(chainLeg.gateway))
        continue;
      inspectedChainGateways.add(chainLeg.gateway);
      if (
        chainLeg.governance === 'spend_cap' &&
        chainLeg.gateway === OFFICIAL_LEG_GATEWAY &&
        isCostedOfficialInsuranceLeg(input.after, point)
      ) {
        continue;
      }
      const chainCandidate = {
        ...candidate,
        gatewayOverride: chainLeg.gateway,
        fallbackGateway: null,
      };
      const chainResult = pricePointBreakEven(chainCandidate, input.floorRub, point);
      const chainIssue = issueFor(
        point,
        chainLeg.leg,
        chainLeg.gateway,
        chainResult.margin,
        FALLBACK_MARGIN_FLOOR,
      );
      if (chainIssue) issues.push(chainIssue);
    }
  }
  return issues;
}

/**
 * Phase 3a scoring path. Admin gateway writes are checked against the signed
 * v2 catalogue, including exact alternate-leg rows. The legacy branch above
 * remains solely for older pure callers while the PATCH route supplies the
 * catalogue below.
 */
function inspectGatewayChangeV2(input: GatewayChangeInput): GatewayMarginIssue[] {
  if (sameExecutableLegs(input.before, input.after)) return [];
  if (input.pricePoints.length === 0) return [noActivePricePointsIssue(input.after)];

  const issues: GatewayMarginIssue[] = [];
  for (const point of input.pricePoints) {
    for (const route of v2Routes(input.after, input.gatewayArming, point.resolution, point.mode)) {
      if (
        route.governance === 'spend_cap' &&
        route.gateway === OFFICIAL_LEG_GATEWAY &&
        isCostedOfficialInsuranceLeg(input.after, point)
      ) {
        continue;
      }
      const margin = v2MarginForRoute(
        input.after.id,
        point,
        route.gateway,
        input.v2Catalogue!,
        input.floorRub,
      );
      const floor = route.leg === 'primary' ? PRIMARY_MARGIN_FLOOR : FALLBACK_MARGIN_FLOOR;
      const issue = issueFor(point, route.leg, route.gateway, margin, floor);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

/**
 * The routes the gate checks for ONE price point. Exported for the same reason
 * `enumerateExecutableLegs` is: which legs get governed is the governance decision, and
 * it is now rung-dependent, so it needs pinning directly rather than through the issues
 * it happens to raise on today's catalogue.
 */
export function v2Routes(
  model: BreakEvenModel,
  gatewayArming?: GatewayArming,
  rung?: string,
  mode?: string,
): GatewayMarginExecutableLeg[] {
  const primary = realGateway(model) || 'unresolved';
  const fallback = configuredFallbackOf(model);
  // A seeded row's `mode: 'any'` means it serves EVERY mode, so the gate must widen to
  // the matcher's wildcard rather than look for a configuration literally spelled 'any'.
  // The widening stops here on purpose: the same string out of `priceModeForRequest`
  // means the contract could not be read, and must never suppress a signed reserve.
  const singleLeg = isSingleLegConfiguration(model.id, rung, mode === 'any' ? undefined : mode);
  const routes: GatewayMarginExecutableLeg[] = [
    { gateway: primary, leg: 'primary', governance: 'margin_floor' },
    ...(!singleLeg && fallback && fallback !== primary
      ? [
          {
            gateway: fallback,
            leg: 'fallback' as const,
            governance: 'margin_floor' as const,
          },
        ]
      : []),
  ];
  const addChain = (gateway: string): void => {
    if (singleLeg) return;
    if (gateway === 'nanobanana') {
      // The alias is priced as whichever relay serves FIRST on this rung, so the
      // explicit fallback must be THE OTHER one. Hardcoding kie was right only while
      // laozhang always led: at gemini-3-1-flash-image 1K the signed leaf is kie, so kie
      // was named twice and laozhang — the leg that actually runs second there, at
      // 1,67% — was checked by nothing.
      //
      // It must be the other relay rather than both, because the leg POSITION is what
      // carries the cost row: laozhang is «основная» on gemini-3-pro-image and «резервная»
      // on gemini-3-1-flash-image 1K. Asking for it as a fallback where it leads finds no
      // row and reports a costed leg as uncosted.
      const signedFirst = signedChainLegOrder(model.id, rung)?.[0] ?? 'laozhang';
      routes.push(
        {
          gateway: signedFirst === 'kie' ? 'laozhang' : 'kie',
          leg: 'fallback',
          governance: 'margin_floor',
        },
        { gateway: OFFICIAL_LEG_GATEWAY, leg: 'last-resort', governance: 'spend_cap' },
      );
    }
    if (gateway === 'geminiomni') {
      routes.push(
        { gateway: 'atlascloud', leg: 'fallback', governance: 'margin_floor' },
        { gateway: OFFICIAL_LEG_GATEWAY, leg: 'last-resort', governance: 'spend_cap' },
      );
    }
  };
  addChain(primary);
  if (fallback && fallback !== primary) addChain(fallback);
  const seen = new Set<string>();
  const chainConfigured = [primary, fallback].some(
    (gateway) => gateway === 'nanobanana' || gateway === 'geminiomni',
  );
  return routes.filter((route) => {
    const key = `${route.gateway}|${route.leg}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!gatewayArming) return true;
    // A chain alias is priced as its first real leaf by v2MarginForRoute; use
    // that same leaf's arming state. Direct model gateways remain visible to
    // the legacy admin gate even when their live key is absent, while a chain
    // tail is included only when its actual adapter can be constructed.
    //
    // The leaf is per-RUNG, so this must read `SIGNED_CHAIN_LEG_ORDER` exactly as the
    // pricing side does. Hardcoding laozhang here while the price used the signed leg
    // let the two halves of one decision disagree: at gemini-3-1-flash-image 1K the
    // signed leaf is kie, so an unarmed laozhang dropped a route the chain still runs,
    // and an unarmed kie priced the alias at kie's 28,49% while the only runnable leg
    // was laozhang at 1,67% — a route waved through nine points under the floor.
    const armingGateway =
      route.gateway === 'nanobanana'
        ? (signedChainLegOrder(model.id, rung)?.[0] ?? 'laozhang')
        : route.gateway === 'geminiomni'
          ? 'kie'
          : route.gateway;
    const isBuiltInChainTail =
      chainConfigured &&
      (route.leg === 'last-resort' ||
        route.gateway === 'nanobanana' ||
        route.gateway === 'geminiomni' ||
        ['kie', 'laozhang', 'atlascloud'].includes(route.gateway));
    if (!isBuiltInChainTail) return true;
    return isGatewayArmed(armingGateway, gatewayArming);
  });
}

function v2MarginForRoute(
  modelId: string,
  point: PricePointForBreakEven,
  gateway: string,
  catalogue: readonly CatalogueEntry[],
  floorRub: number,
): number | null {
  if (!Number.isFinite(floorRub) || floorRub <= 0 || point.baseCredits <= 0) return null;

  // A chain alias is priced as the leaf that actually serves FIRST. That is the chain's
  // construction order for most of the family, but `SIGNED_CHAIN_LEG_ORDER` moves it per
  // (model, rung) where finance's signed margins invert between rungs — pricing
  // gemini-3-1-flash-image 1K against laozhang here would report 1,67% for a request the
  // adapter now sends to kie at 28,49%.
  const signedFirstLeg = signedChainLegOrder(modelId, point.resolution)?.[0];
  const pricedGateway =
    gateway === 'nanobanana'
      ? (signedFirstLeg ?? 'laozhang')
      : gateway === 'geminiomni'
        ? 'kie'
        : gateway === OFFICIAL_LEG_GATEWAY
          ? 'openrouter'
          : gateway.toLowerCase();

  const refsMin = point.refsMin ?? 0;
  const refsMax = point.refsMax ?? 0;
  const references = refsMax || refsMin;
  const units = point.flatRate ? 1 : point.baseUnits;
  const revenueRub = point.baseCredits * floorRub;
  const baseModelId = splitModelId(modelId).modelId;
  const margins = catalogue
    .filter(
      (entry) =>
        entry.modelId === baseModelId &&
        (entry.quality ?? entry.rung) === point.resolution &&
        (entry.audio === null || entry.audio === point.audio) &&
        (point.mode === undefined || point.mode === 'any' || entry.mode === point.mode) &&
        entry.legs[0] !== undefined &&
        entry.legs[0].refsMin === refsMin &&
        entry.legs[0].refsMax === refsMax,
    )
    .flatMap((entry) =>
      entry.legs
        .filter(
          (leg) =>
            leg.relay.toLowerCase() === pricedGateway &&
            leg.costKnown &&
            Number.isFinite(leg.landedRubPerUnit) &&
            leg.landedRubPerUnit > 0,
        )
        .flatMap((leg) => {
          const usd = usdAtReferenceCount(leg, references);
          if (
            usd === null ||
            !Number.isFinite(usd) ||
            usd < 0 ||
            !Number.isFinite(units) ||
            units <= 0
          ) {
            return [];
          }
          return [1 - (usd * leg.landedRubPerUnit * units) / revenueRub];
        }),
    )
    .filter((margin) => Number.isFinite(margin));
  return margins.length > 0 ? Math.min(...margins) : null;
}
