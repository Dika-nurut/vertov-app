import {
  costCatalogue,
  executableIdentity,
  landedRubPerUsd,
  servingModelId,
  splitModelId,
  usdAtReferenceCount,
  type CatalogueEntry,
  type CostedLeg,
  type CostLeg,
  type Mode,
} from '@seed/db';
import {
  contractForGateway,
  type ContractGateway,
  type ModelGatewayContract,
} from './model-contract';
import { byteplusRouteContracts } from './model-contract-byteplus';
import { contractGatewayForRelay } from './relay-gateway';

export type FrameRole = 'first' | 'last';

/** Health values accepted by the selector's injected feed. */
export type LegHealth = boolean | 'healthy' | 'unhealthy' | { healthy: boolean; detail?: string };

export type LegHealthProvider = (legIdentity: string) => LegHealth;

/** The facts already resolved by the caller for one generation request. */
export interface RouteRequest {
  entry: CatalogueEntry;
  references: number;
  durationSeconds: number | null;
  frames: readonly FrameRole[];
  audio: boolean;
  resolution: string | null;
  aspect: string | null;
  units: number;
  /** Revenue is supplied by the caller; the selector never derives a floor. */
  revenueRub: number;
  health: LegHealthProvider;
  /** Counts of typed non-image references, when the request carries them. */
  videoReferences?: number;
  audioReferences?: number;
  /**
   * Whether THIS model has opted in to the official-OpenRouter third leg
   * (`capabilities.openrouterFallbackSlug` + a per-rung `officialUsdPerUnit`).
   * Only the two built-in chains have one at all, and both caps ship at zero.
   * Defaults to false: absent means no such leg, never «unknown».
   */
  hasOfficialLeg?: boolean;
}

export type RouteRejectionReason =
  | 'incapable'
  | 'capability_unknown'
  | 'uncosted'
  | 'loss_making'
  | 'unhealthy'
  | 'official_leg_excluded';

export type CapabilityUnknownKind = 'model_absent' | 'gateway_absent' | 'ambiguous_max_images';

/**
 * These stay as asserted constants rather than being deleted: the guard in
 * select-route.test.ts enumerates the legs independently and pins the unknown set
 * against them, so a newly-costed leg that arrives without a contract fails CI
 * instead of being quietly refused in production.
 *
 * The AtlasCloud omni leg is now wired from the committed vendor schema capture;
 * the newly-costed-leg warning remains enforced by the independent enumeration.
 *
 * BACK TO ZERO in rev. 15, and the resolution is worth keeping because we asked the
 * wrong question. rev. 13 had promoted five nano-banana reserve legs into priced rows
 * with the ПОСРЕДНИК cell left as `—`, and we asked finance to name the vendor. There
 * was no vendor to name: the reserve rate was a byte-identical copy of the primary's,
 * typed to fill a column, and the five configurations have no failover at all. The
 * export now says `ГЛУБИНА ЛЕСТНИЦЫ = 1` on every one of them, and their
 * generator refuses to emit a leg without a named relay.
 *
 * So the count returns to 0 not because the vendors were named but because the legs were
 * never there. A placeholder that copies the primary's rate is indistinguishable from a
 * real reserve in every arithmetic check — prices and margins do not move when it is
 * removed, which is precisely why it survived three revisions.
 */
export const CAPABILITY_UNKNOWN_MODEL_ABSENT = 0;
export const CAPABILITY_UNKNOWN_GATEWAY_ABSENT = 0;
export const CAPABILITY_UNKNOWN_TOTAL = 0;

/** The third chain leg is not a CostLeg, but its exclusion must remain visible. */
export interface OfficialOpenRouterLeg {
  modelId: string;
  rung: string;
  mode: Mode;
  leg: 3;
  gateway: 'openrouter-official';
  /** Unique per configuration — a shared constant collided across every entry. */
  executableIdentity: string;
}

export interface RouteRejection {
  leg: CostLeg | OfficialOpenRouterLeg;
  reason: RouteRejectionReason;
  detail: string;
  unknownKind?: CapabilityUnknownKind;
}

export interface RouteDecision {
  ordered: CostedLeg[];
  rejected: RouteRejection[];
}

/** Phase 3a owns real exceptions. Phase 2 deliberately ships an empty list. */
export interface LossMakingException {
  legIdentity: string;
  expiresOn: string;
}

export const LOSS_MAKING_EXCEPTIONS: readonly LossMakingException[] = [];

const KNOWN_MODEL_IDS = new Set(Object.keys(byteplusRouteContracts));

function modelIdForEntry(entry: CatalogueEntry): string {
  if (byteplusRouteContracts[entry.modelId]) return entry.modelId;
  const baseModelId = splitModelId(entry.modelId).modelId;
  return (
    servingModelId({ modelId: entry.modelId, mode: entry.mode }, KNOWN_MODEL_IDS) ?? baseModelId
  );
}

function healthIsHealthy(value: LegHealth): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'healthy';
  return value.healthy;
}

function healthDetail(value: LegHealth): string {
  if (typeof value === 'object' && value !== null && 'detail' in value && value.detail) {
    return value.detail;
  }
  return 'injected health provider reports this leg unhealthy';
}

function enumRejectsValue(
  contract: { values: readonly string[]; onInvalid: string; reject?: readonly string[] },
  value: string | null,
): boolean {
  if (value === null) return false;
  if (contract.reject?.some((candidate) => candidate.toLowerCase() === value.toLowerCase())) {
    return true;
  }
  return !contract.values.includes(value) && contract.onInvalid === 'reject';
}

function qualityOrResolution(input: RouteRequest): string | null {
  // Finance stores image quality in CostLeg.quality while the contract calls the
  // same closed set resolution values. The entry is the resolved price identity,
  // so its default-rung quality is authoritative for this leg-level check.
  if (input.entry.rung === 'default' && input.entry.quality !== null) {
    return input.entry.quality;
  }
  return input.resolution;
}

function incapableDetail(input: RouteRequest, contract: ModelGatewayContract): string | null {
  const reference = contract.reference;
  if (input.frames.length > 0 && reference.imageRole !== 'frame') {
    return `request needs frames (${input.frames.join(',')}) but this route accepts ${reference.imageRole}`;
  }
  if (input.references > 0 && reference.imageRole === 'none') {
    return `request has ${input.references} image references but this route accepts none`;
  }
  if (reference.maxImages > 0 && input.references > reference.maxImages) {
    return `request has ${input.references} image references; route cap is ${reference.maxImages}`;
  }
  if (reference.maxVideos > 0 && (input.videoReferences ?? 0) > reference.maxVideos) {
    return `request has ${input.videoReferences} video references; route cap is ${reference.maxVideos}`;
  }
  if (reference.maxAudios > 0 && (input.audioReferences ?? 0) > reference.maxAudios) {
    return `request has ${input.audioReferences} audio references; route cap is ${reference.maxAudios}`;
  }

  const resolution = qualityOrResolution(input);
  if (contract.resolution && enumRejectsValue(contract.resolution, resolution)) {
    return `resolution '${resolution}' is rejected by this route contract`;
  }
  if (contract.aspectRatio && enumRejectsValue(contract.aspectRatio, input.aspect)) {
    return `aspect '${input.aspect}' is rejected by this route contract`;
  }

  if (contract.duration && input.durationSeconds !== null) {
    if (
      input.durationSeconds > contract.duration.max &&
      contract.duration.onAboveMax === 'reject'
    ) {
      return `duration ${input.durationSeconds}s exceeds route maximum ${contract.duration.max}s`;
    }
    if (
      input.durationSeconds < contract.duration.min &&
      contract.duration.onBelowMin === 'reject'
    ) {
      return `duration ${input.durationSeconds}s is below route minimum ${contract.duration.min}s`;
    }
  }
  if (input.audio && !contract.audio.output) {
    return 'request wants audio output but this route does not produce audio';
  }
  return null;
}

function unknownFor(
  entry: CatalogueEntry,
  leg: CostLeg,
): { kind: CapabilityUnknownKind; detail: string } | null {
  const modelId = modelIdForEntry(entry);
  const contracts = byteplusRouteContracts[modelId];
  if (!contracts) {
    return {
      kind: 'model_absent',
      detail: `model '${modelId}' is absent from byteplusRouteContracts`,
    };
  }
  const gateway = contractGatewayForRelay(leg.relay);
  if (!gateway) {
    return {
      kind: 'gateway_absent',
      detail: `relay '${leg.relay}' has no ContractGateway mapping`,
    };
  }
  const contract = contractForGateway(contracts, gateway);
  if (!contract) {
    return {
      kind: 'gateway_absent',
      detail: `model '${modelId}' has no contract for gateway '${gateway}'`,
    };
  }

  return null;
}

function ambiguousMaxImagesDetail(
  modelId: string,
  gateway: ContractGateway,
  input: RouteRequest,
  contract: ModelGatewayContract,
): string | null {
  // A zero image cap on a route that otherwise advertises image conditioning is
  // not a trustworthy assertion that the route rejects generic images. Frame
  // routes use zero for the generic-image field, so their positional frame
  // capability remains evaluable (Wan's OR leg is the pinned case). Surface the
  // ambiguity only when this request actually asks for generic references.
  if (
    contract.reference.maxImages === 0 &&
    contract.reference.imageRole !== 'none' &&
    input.references > 0
  ) {
    return `model '${modelId}' route '${gateway}' has an ambiguous maxImages=0 reference cap`;
  }
  return null;
}

function isLossException(legIdentity: string, now: Date): boolean {
  const time = now.getTime();
  return LOSS_MAKING_EXCEPTIONS.some(
    (exception) =>
      exception.legIdentity === legIdentity &&
      Number.isFinite(Date.parse(`${exception.expiresOn}T00:00:00Z`)) &&
      Date.parse(`${exception.expiresOn}T00:00:00Z`) > time,
  );
}

/**
 * The official-OpenRouter third leg, and ONLY where one actually exists.
 *
 * It is not a property of every configuration: it exists only on the two built-in
 * chains (`nanobanana` = laozhang → kie → official, `geminiomni` = kie → atlascloud
 * → official), and a row reaches it only by opting in with its own per-rung rate.
 * Both spend caps ship at zero.
 *
 * Emitting the marker unconditionally — the first version of this — claimed a third
 * leg for Veo, Seedance and everything else, and gave all of them the SAME
 * `executableIdentity`, so they collided. A shadow log reading `rejected` would have
 * concluded the whole catalogue carries official-leg insurance. The caller knows
 * whether the model opted in; the selector does not, so it must be told.
 */
function officialLegFor(input: RouteRequest): OfficialOpenRouterLeg | null {
  if (!input.hasOfficialLeg) return null;
  const { entry } = input;
  return {
    modelId: entry.modelId,
    rung: entry.rung,
    mode: entry.mode,
    leg: 3,
    gateway: 'openrouter-official',
    executableIdentity: `openrouter-official|${entry.modelId}|${entry.rung}|${entry.mode}`,
  };
}

/**
 * Select the cheapest survivable leg for one already-resolved catalogue entry.
 * This function has no I/O, clock, environment, or mutation; `now` exists only
 * for the typed, currently-empty owner exception list.
 */
export function selectRoute(input: RouteRequest, now: Date): RouteDecision {
  const ordered: CostedLeg[] = [];
  const rejected: RouteRejection[] = [];

  // Validate units once through the same invariant the costing kernel enforces.
  if (!Number.isFinite(input.units) || input.units <= 0) {
    throw new RangeError(`units must be finite and positive, got ${input.units}`);
  }

  const modelId = modelIdForEntry(input.entry);
  const contracts = byteplusRouteContracts[modelId];

  for (const leg of input.entry.legs) {
    const identity = executableIdentity(leg);
    const unknown = unknownFor(input.entry, leg);
    if (!contracts || unknown) {
      rejected.push({
        leg,
        reason: 'capability_unknown',
        detail: unknown?.detail ?? `model '${modelId}' has no capability contracts`,
        unknownKind: unknown?.kind ?? 'model_absent',
      });
      continue;
    }

    const gateway = contractGatewayForRelay(leg.relay) as ContractGateway;
    const contract = contractForGateway(contracts, gateway);
    // `unknownFor` above is the only gateway join. This guard is defensive and
    // keeps the no-silent-drop invariant true if the registry changes concurrently.
    if (!contract) {
      rejected.push({
        leg,
        reason: 'capability_unknown',
        detail: `model '${modelId}' has no contract for gateway '${gateway}'`,
        unknownKind: 'gateway_absent',
      });
      continue;
    }

    const incapable = incapableDetail(input, contract);
    if (incapable) {
      rejected.push({ leg, reason: 'incapable', detail: incapable });
      continue;
    }

    const ambiguousMaxImages = ambiguousMaxImagesDetail(modelId, gateway, input, contract);
    if (ambiguousMaxImages) {
      rejected.push({
        leg,
        reason: 'capability_unknown',
        detail: ambiguousMaxImages,
        unknownKind: 'ambiguous_max_images',
      });
      continue;
    }

    const usd = usdAtReferenceCount(leg, input.references);
    if (usd === null) {
      rejected.push({
        leg,
        reason: 'uncosted',
        detail: `no cost row covers ${input.references} references for this leg`,
      });
      continue;
    }

    const landedRubTotal = usd * landedRubPerUsd(leg) * input.units;
    if (landedRubTotal > input.revenueRub && !isLossException(identity, now)) {
      rejected.push({
        leg,
        reason: 'loss_making',
        detail: `landed cost ${landedRubTotal} ₽ exceeds revenue ${input.revenueRub} ₽`,
      });
      continue;
    }

    const health = input.health(identity);
    if (!healthIsHealthy(health)) {
      rejected.push({ leg, reason: 'unhealthy', detail: healthDetail(health) });
      continue;
    }

    ordered.push({
      leg,
      landedRubTotal,
      upstream: leg.upstream,
      executableIdentity: identity,
    });
  }

  ordered.sort((a, b) => a.landedRubTotal - b.landedRubTotal || a.leg.leg - b.leg.leg);
  const officialLeg = officialLegFor(input);
  if (officialLeg) {
    rejected.push({
      leg: officialLeg,
      reason: 'official_leg_excluded',
      detail:
        'the official OpenRouter chain leg is capped insurance, not a priced route; it is never scored',
    });
  }
  return { ordered, rejected };
}

export interface RouteEntrySelector {
  modelId: string;
  resolution: string;
  references: number;
  mode?: string;
  audio?: boolean;
}

function modeForReferenceBand(
  modelId: string,
  resolution: string,
  references: number,
  catalogue: readonly CatalogueEntry[],
): Mode | null {
  const baseModelId = splitModelId(modelId).modelId;
  const exactRung = catalogue.filter(
    (entry) =>
      entry.modelId === baseModelId && entry.rung === resolution && entry.legs[0]!.refsMax > 0,
  );
  const band = exactRung.find(
    (entry) => references >= entry.legs[0]!.refsMin && references <= entry.legs[0]!.refsMax,
  );
  return band?.mode ?? null;
}

/** Resolve a static catalogue entry for shadow/offline callers, not live routing. */
export function resolveCatalogueEntry(
  selector: RouteEntrySelector,
  catalogue: readonly CatalogueEntry[] = costCatalogue(),
): CatalogueEntry | null {
  const split = splitModelId(selector.modelId);
  const bandMode = modeForReferenceBand(
    selector.modelId,
    selector.resolution,
    selector.references,
    catalogue,
  );
  const explicitMode = selector.mode && selector.mode !== 'any' ? selector.mode : null;
  // A reference band is selected from the request count, not from the legacy
  // price-point mode (which is deliberately `any`). It therefore wins over a
  // caller's coarse t2i/i2i mode whenever the catalogue has a matching band.
  const requestedMode = bandMode ?? explicitMode;
  const preferredMode = requestedMode ?? split.mode ?? 't2i';
  const hasQualityTier = catalogue.some(
    (entry) =>
      entry.modelId === split.modelId &&
      entry.rung === 'default' &&
      entry.quality === selector.resolution,
  );
  const requestedRung = hasQualityTier ? 'default' : selector.resolution;
  const candidates = catalogue.filter(
    (entry) =>
      entry.modelId === split.modelId &&
      entry.rung === requestedRung &&
      (!hasQualityTier || entry.quality === selector.resolution) &&
      (entry.audio === null || selector.audio === undefined || entry.audio === selector.audio) &&
      (requestedMode === null || requestedMode === undefined || entry.mode === requestedMode),
  );
  const preferred = candidates.find((entry) => entry.mode === preferredMode);
  if (preferred) return preferred;
  if (candidates.length === 1) return candidates[0]!;
  return candidates.find((entry) => entry.mode === 't2i' || entry.mode === 't2v') ?? null;
}
