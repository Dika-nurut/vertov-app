/**
 * Route-aware PRODUCT contract (execution plan DoD 5). A model runs on a primary
 * route plus zero or more availability fallbacks, and those routes can accept
 * different parameters. The product contract the API publishes must be deliberate:
 * the scalar menus (resolution / aspect / duration) are the INTERSECTION every
 * eligible route can honor, so a job is never silently DOWNGRADED when the circuit
 * breaker fails it over to a fallback. Conditioning (frames / references) is the
 * UNION — a frame job the primary can't take fails over to a route that can, so the
 * capability is genuinely deliverable product-wide. Any place the primary offers
 * more than a fallback guarantees is reported in `downgrades` as an explicit,
 * declared policy rather than a silent surprise.
 */

import type { ContractGateway, ModelGatewayContract } from './model-contract';

export interface ProductContract {
  modelId: string;
  primaryGateway: ContractGateway;
  fallbackGateways: ContractGateway[];
  /** Resolutions every route can serve (intersection). Null when the model has no resolution control. */
  resolution: readonly string[] | null;
  /** Aspect ratios every route can serve (intersection). */
  aspectRatio: readonly string[] | null;
  /** Duration window every route can serve: min = the highest floor, max = the lowest ceiling. */
  duration: { min: number; max: number } | null;
  /** Frame roles deliverable via SOME route (union). */
  frameRoles: readonly ('first' | 'last')[];
  /** Reference maxima deliverable via some route (union). */
  reference: { maxImages: number; maxVideos: number; maxAudios: number };
  /** The output can contain generated audio via some route. */
  audioOutput: boolean;
  /** A real generate_audio toggle is offered iff the PRIMARY route accepts it. */
  audioControl: boolean;
  /** Human-readable failover downgrade declarations (empty = no silent downgrade risk). */
  downgrades: string[];
}

/** Catalog reference metadata is the sellable typed-input surface. An absent
 * `reference:true` withholds the entire channel; individual maxima may then narrow
 * a channel that is otherwise advertised. */
export type CatalogReferenceCapabilities = Readonly<Record<string, unknown>> | null | undefined;

function catalogReferenceMaximum(
  vendorMaximum: number,
  capabilities: CatalogReferenceCapabilities,
  key: 'maxRefs' | 'maxVideoRefs' | 'maxAudioRefs',
): number {
  const catalogMaximum = capabilities?.[key];
  return typeof catalogMaximum === 'number' &&
    Number.isInteger(catalogMaximum) &&
    catalogMaximum >= 0
    ? Math.min(vendorMaximum, catalogMaximum)
    : vendorMaximum;
}

function intersectStrings(lists: (readonly string[])[]): string[] {
  if (lists.length === 0) return [];
  const [first, ...rest] = lists;
  return first!.filter((v) => rest.every((l) => l.includes(v)));
}

/**
 * Resolve one enum menu (resolution / aspect) across all routes. The published set is
 * the intersection of the routes that HAVE the menu; a route that LACKS it renders its
 * own default, so it cannot guarantee any requested value — reported as an explicit
 * downgrade, never silently ignored. Primary-only values dropped by the intersection
 * are likewise declared.
 */
function resolveMenu(
  contracts: readonly ModelGatewayContract[],
  primary: ModelGatewayContract,
  get: (c: ModelGatewayContract) => readonly string[] | undefined,
  label: string,
): { values: string[] | null; notes: string[] } {
  const primaryValues = get(primary);
  if (!primaryValues) return { values: null, notes: [] };
  const notes: string[] = [];
  const present = contracts.filter((c) => get(c));
  const absent = contracts.filter((c) => !get(c));
  const values = intersectStrings(present.map((c) => get(c)!));
  const dropped = primaryValues.filter((v) => !values.includes(v));
  if (dropped.length > 0) {
    notes.push(
      `${label} ${dropped.join('/')} is served only by the primary (${primary.gateway}); a failover cannot deliver it`,
    );
  }
  if (absent.length > 0) {
    notes.push(
      `${label} is not honored on the ${absent.map((c) => c.gateway).join('/')} route (renders its default)`,
    );
  }
  return { values, notes };
}

/**
 * Resolve a model's route set into the published product contract. Deterministic:
 * routes keep their given order; `downgrades` are emitted in a stable order.
 */
export function resolveProductContract(
  contracts: readonly ModelGatewayContract[],
  catalogCapabilities?: CatalogReferenceCapabilities,
): ProductContract | null {
  if (contracts.length === 0) return null;
  const primary = contracts.find((c) => c.role === 'primary') ?? contracts[0]!;
  const fallbacks = contracts.filter((c) => c !== primary);
  const downgrades: string[] = [];

  // Scalar menus: intersection across every route (UI-safe — no failover downgrade),
  // with an explicit declaration for any primary-only value or absent-control route.
  const resMenu = resolveMenu(contracts, primary, (c) => c.resolution?.values, 'resolution');
  const aspMenu = resolveMenu(contracts, primary, (c) => c.aspectRatio?.values, 'aspect ratio');
  const resolution = resMenu.values;
  const aspectRatio = aspMenu.values;
  downgrades.push(...resMenu.notes, ...aspMenu.notes);

  // Duration window: highest floor, lowest ceiling across routes. A route without a
  // duration control, a raised floor, or a lowered ceiling is each declared.
  let duration: { min: number; max: number } | null = null;
  if (primary.duration) {
    const present = contracts.filter((c) => c.duration);
    const absent = contracts.filter((c) => !c.duration);
    const min = Math.max(...present.map((c) => c.duration!.min));
    const max = Math.min(...present.map((c) => c.duration!.max));
    duration = { min, max };
    if (primary.duration.max > max) {
      downgrades.push(
        `duration up to ${primary.duration.max}s is served only by the primary (${primary.gateway}); a failover caps at ${max}s`,
      );
    }
    if (primary.duration.min < min) {
      downgrades.push(
        `duration floor rises from ${primary.duration.min}s to ${min}s on a failover`,
      );
    }
    if (absent.length > 0) {
      downgrades.push(
        `duration is not honored on the ${absent.map((c) => c.gateway).join('/')} route`,
      );
    }
  }

  // Conditioning: union — deliverable via whichever route supports it.
  const frameRoles = (['first', 'last'] as const).filter((role) =>
    contracts.some(
      (c) => c.reference.imageRole === 'frame' && c.reference.frameRoles.includes(role),
    ),
  );
  const vendorReference = {
    maxImages: Math.max(...contracts.map((c) => c.reference.maxImages)),
    maxVideos: Math.max(...contracts.map((c) => c.reference.maxVideos)),
    maxAudios: Math.max(...contracts.map((c) => c.reference.maxAudios)),
  };
  // The registry remains factual about every vendor leg. The catalog is the
  // sellable product surface: it can withhold a channel entirely when routing
  // cannot safely select its supporting leg, or narrow an individual typed cap.
  const referencesAdvertised = catalogCapabilities?.['reference'] === true;
  const reference = {
    maxImages: referencesAdvertised
      ? catalogReferenceMaximum(vendorReference.maxImages, catalogCapabilities, 'maxRefs')
      : 0,
    maxVideos: referencesAdvertised
      ? catalogReferenceMaximum(vendorReference.maxVideos, catalogCapabilities, 'maxVideoRefs')
      : 0,
    maxAudios: referencesAdvertised
      ? catalogReferenceMaximum(vendorReference.maxAudios, catalogCapabilities, 'maxAudioRefs')
      : 0,
  };
  // A reference channel only some routes accept is a failover downgrade (a typed
  // video/audio reference the primary takes but a fallback drops).
  for (const [label, key] of [
    ['video references', 'maxVideos'],
    ['audio references', 'maxAudios'],
  ] as const) {
    const primaryMax = primary.reference[key];
    const worst = Math.min(...contracts.map((c) => c.reference[key]));
    if (reference[key] > 0 && primaryMax > worst) {
      downgrades.push(
        `${label} accepted by the primary (${primary.gateway}) are dropped on a failover that caps at ${worst}`,
      );
    }
  }

  const audioOutput = contracts.some((c) => c.audio.output);
  const audioControl = primary.audio.control;
  // A generate_audio toggle honored by the primary but not by a fallback silently
  // stops working on failover (the clip still gets audio) — a declared downgrade.
  if (audioControl && contracts.some((c) => !c.audio.control)) {
    const offenders = contracts
      .filter((c) => !c.audio.control)
      .map((c) => c.gateway)
      .join('/');
    downgrades.push(
      `the generate_audio toggle is ignored on the ${offenders} fallback (audio is emitted regardless)`,
    );
  }

  return {
    modelId: primary.modelId,
    primaryGateway: primary.gateway,
    fallbackGateways: fallbacks.map((c) => c.gateway),
    resolution,
    aspectRatio,
    duration,
    frameRoles,
    reference,
    audioOutput,
    audioControl,
    downgrades,
  };
}
