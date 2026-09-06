/**
 * modelGatewayContractRegistry — the ONE authority for every model's real,
 * gateway-specific parameters (execution plan: docs/business/parametric-contract-execution-plan-2026-07-20.md).
 *
 * A single model runs on one or more gateways (a cheapest PRIMARY plus zero or
 * more availability FALLBACKs). Each (modelId, gateway, inputMode) triple has its
 * OWN accepted-parameter surface, because the vendors genuinely disagree: kie's
 * Seedance Fast route has no 1080p, kie's Wan route is text-to-video only and
 * emits audio it never lets you toggle, etc. Today those truths are scattered
 * across three places that drift — the hand-authored catalog `capabilities`, the
 * adapter body-builders, and the provider API. This registry is where they become
 * one source, from which the catalog, adapters, pricing, server validation, and
 * both UIs derive.
 *
 * Phase 1 (this file) defines the provider-NEUTRAL types plus the pure projection
 * used by the catalog-parity CI guard. Concrete per-provider contract DATA lives
 * in sibling files (e.g. `model-contract-byteplus.ts`); adapters are rewired to
 * read the registry in Phase 2.
 */

/** The gateways a model can be served through. Mirrors the routing surface in
 * apps/api/src/jobs-routes.ts (gatewayOverride / forceGateway / fallbackGateway). */
export type ContractGateway =
  | 'openrouter'
  | 'kie'
  | 'atlascloud'
  | 'laozhang'
  | 'nanobanana'
  | 'geminiomni';

/** The coarse input mode the registry is keyed on. Fine-grained slug splits
 * (text-to-image vs image-to-image, text-to-video vs image-to-video) are a
 * serializer concern captured per-contract, not a separate key. */
export type ContractInputMode = 'image' | 'video';

/** Whether a route is the cheapest preferred leg or an availability fallback. */
export type ContractRole = 'primary' | 'fallback';

/**
 * Where a contract's facts come from. A price or an accepted-field set must never
 * be locked in on a guess: 'verified' = confirmed against a real paid generation
 * (cite the taskId), 'snapshot' = read from a dated vendor dashboard/doc with no
 * price API, 'inferred' = derived with no direct evidence (the weakest, flag it).
 */
export interface ContractProvenance {
  source: 'verified' | 'snapshot' | 'inferred';
  /** ISO date (YYYY-MM-DD) the evidence was captured — snapshots carry a re-pull reminder. */
  date: string;
  /** Pointer to the evidence: a taskId, a doc anchor, a live 422 note. */
  note: string;
}

/**
 * A closed set of accepted values (resolution, aspect ratio). `onInvalid` is the
 * normalization policy the serving route actually applies to an off-menu request:
 *  - 'reject'      — throw (a paid property we cannot deliver, e.g. veo 4K);
 *  - 'snap'        — map to the nearest allowed value (kie gemini-omni aspect ratio);
 *  - 'omit'        — drop the field and let the model infer it;
 *  - 'default'     — validate against `values` and fall back to `default` off-menu;
 *  - 'passthrough' — forward the requested string UNCHANGED (the route does no
 *                    validation), applying `default` only when the field is absent.
 *                    kie's Seedance route is a passthrough: it sends whatever
 *                    aspect_ratio string it is given.
 */
export interface EnumParamContract<T extends string = string> {
  kind: 'enum';
  values: readonly T[];
  default: T;
  onInvalid: 'reject' | 'snap' | 'omit' | 'default' | 'passthrough';
  /**
   * Values that are ALWAYS rejected regardless of `onInvalid` — a per-value guard
   * for a paid property the route cannot deliver even though a nearby default could
   * substitute. veo's `4K` is the case: it is neither wired nor priced, so it must
   * reject rather than silently downgrade to 720p (which a bare `onInvalid:'default'`
   * would do). Case-insensitive.
   */
  reject?: readonly string[];
}

/**
 * A duration parameter. `steps` is the discrete menu we EXPOSE for this route (the
 * choices the UI offers and the catalog advertises; also what a snapping route maps
 * to). `acceptsIntermediate` records whether the route ALSO honors non-menu integers
 * in [min, max] — true for kie (it forwards `5`/`7`/`9` verbatim), false for
 * OpenRouter (buildOpenRouterVideoBody snaps every request down to the menu). `min`
 * is the vendor floor that is both delivered AND billed — a sub-min request is
 * floored, never charged for seconds it will not receive. `max` is the hard ceiling;
 * `onAboveMax` says whether an over-max request is rejected (the charge path bills
 * the requested seconds, so clamping down would deliver fewer than charged) or
 * clamped to the top of the menu.
 */
export interface DurationParamContract {
  kind: 'duration';
  steps: readonly number[] | null;
  acceptsIntermediate: boolean;
  min: number;
  max: number;
  default: number;
  onBelowMin: 'floor' | 'reject';
  onAboveMax: 'reject' | 'clamp';
}

/** The conditioning inputs a route accepts. Frame roles are the ordered i2v
 * anchor slots; reference maxima are the typed multi-reference caps. */
export interface ReferenceContract {
  imageRole: 'none' | 'frame' | 'reference';
  frameRoles: readonly ('first' | 'last')[];
  maxImages: number;
  maxVideos: number;
  maxAudios: number;
  /**
   * MIXED conditioning: a `frame` route that ALSO accepts generic image references
   * beyond its frame slot(s). Projects an extra `reference:true`.
   */
  genericReference?: boolean;
}

/**
 * Audio, split into the two facts the catalog conflates today:
 *  - `output`  — the delivered clip contains generated audio (a fact about the result);
 *  - `control` — the route accepts a real user-facing `generate_audio` toggle
 *                (a fact about the request). kie's Wan/HappyHorse routes emit
 *                audio jointly with video and take NO toggle, so output can be true
 *                while control is false — a distinction the UI needs so it never
 *                shows a dead generate_audio switch.
 */
export interface AudioContract {
  output: boolean;
  control: boolean;
}

/** One concrete (modelId, gateway, inputMode) contract. */
export interface ModelGatewayContract {
  modelId: string;
  gateway: ContractGateway;
  inputMode: ContractInputMode;
  role: ContractRole;
  /** The vendor `model` string this route serializes to (the adapter slug). */
  slug: string;
  resolution?: EnumParamContract;
  aspectRatio?: EnumParamContract;
  duration?: DurationParamContract;
  reference: ReferenceContract;
  audio: AudioContract;
  /** The route accepts a real `negative_prompt` field (not merely advertises one). */
  negativePrompt: boolean;
  provenance: ContractProvenance;
}

/**
 * The catalog `capabilities` keys the registry OWNS and the parity guard checks.
 * Deliberately the pure param-menu surface — routing directives (forceGateway,
 * fallbackGateway) and pricing/provenance fields (priceUsdPerUnit, passthrough)
 * are owned by later phases and are ignored here so this foundation stays a
 * zero-behavior-change, purely-additive slice.
 */
export const REGISTRY_MANAGED_CAPABILITY_KEYS = [
  'resolutions',
  'aspect_ratios',
  'durations',
  'audio',
  'frames',
  'reference',
  'multi_image',
  'maxRefs',
  'maxVideoRefs',
  'maxAudioRefs',
] as const;

export type RegistryManagedCapabilityKey = (typeof REGISTRY_MANAGED_CAPABILITY_KEYS)[number];

/**
 * Project a model's full route set into the subset of catalog `capabilities` the
 * seed must contain. This is the "catalog is GENERATED from the registry" arrow
 * (DoD 2): the parity guard asserts the committed catalog's managed keys equal
 * this output.
 *
 * The catalog bag is a PRODUCT surface, so it mixes routes exactly as the seed
 * does today: scalar menus (resolution / aspect / duration) come from the PRIMARY
 * route, while conditioning (frames / references) and output-audio are the UNION
 * across every route — that is why Wan's catalog advertises `frames:['first','last']`
 * (served only by its OpenRouter fallback) alongside its kie-primary resolutions.
 * This Phase-1 rule is a deliberate simplification that reproduces the current
 * seed; the route-aware intersection/downgrade resolver is Phase 3. The guard's
 * job meanwhile is to fail on any DRIFT from the committed truth.
 *
 * It reproduces the seed's omit-when-default conventions (a false `negativePrompt`
 * is omitted, the generate_audio control split is not projected), so the
 * foundation adds no field the catalog does not already carry.
 */
export function deriveCatalogCapabilities(
  contracts: readonly ModelGatewayContract[],
): Partial<Record<RegistryManagedCapabilityKey, unknown>> {
  if (contracts.length === 0) return {};
  const primary = contracts.find((c) => c.role === 'primary') ?? contracts[0]!;
  const caps: Partial<Record<RegistryManagedCapabilityKey, unknown>> = {};

  // Scalar menus: the primary route decides what the product exposes.
  if (primary.resolution) caps.resolutions = [...primary.resolution.values];
  if (primary.aspectRatio) caps.aspect_ratios = [...primary.aspectRatio.values];
  if (primary.duration?.steps) caps.durations = [...primary.duration.steps];

  // Output-audio: true if ANY route delivers audio (the seed's `audio` flag). The
  // generate_audio CONTROL split lives in the registry and reaches the UI later,
  // so it is intentionally not projected here.
  if (primary.inputMode === 'video') {
    caps.audio = contracts.some((c) => c.audio.output);
  }

  // Conditioning: the union across routes, so a capability served only by a
  // fallback leg still surfaces product-wide (Wan frames).
  const frameRoles = new Set<'first' | 'last'>();
  let maxImages = 0;
  let maxVideos = 0;
  let maxAudios = 0;
  let anyReference = false;
  let anyGenericReference = false;
  for (const c of contracts) {
    if (c.reference.imageRole === 'frame') {
      for (const role of c.reference.frameRoles) frameRoles.add(role);
      if (c.reference.genericReference) anyGenericReference = true;
    } else if (c.reference.imageRole === 'reference') {
      anyReference = true;
      maxImages = Math.max(maxImages, c.reference.maxImages);
      maxVideos = Math.max(maxVideos, c.reference.maxVideos);
      maxAudios = Math.max(maxAudios, c.reference.maxAudios);
    }
  }
  // Frame conditioning (i2v anchor slots) and reference conditioning are INDEPENDENT:
  // a mixed route emits both. Frames first.
  if (frameRoles.size > 0) {
    // Preserve the seed's ['first','last'] ordering rather than Set insertion order.
    caps.frames = (['first', 'last'] as const).filter((r) => frameRoles.has(r));
  } else if (
    primary.inputMode === 'video' &&
    contracts.every((c) => c.reference.imageRole === 'none')
  ) {
    // Explicit text-to-video: EVERY route rejects conditioning. The seed records
    // this as `frames: []` (authoritative "no frames", distinct from an absent key
    // that means legacy-inferred first+last), so the projection must too — e.g. grok.
    caps.frames = [];
  }

  // Reference conditioning: typed multi-references (union), OR a generic-reference
  // frame route.
  if (anyReference || anyGenericReference) {
    caps.reference = true;
    if (maxImages > 1) caps.multi_image = true;
    if (maxImages > 0) caps.maxRefs = maxImages;
    if (maxVideos > 0) caps.maxVideoRefs = maxVideos;
    if (maxAudios > 0) caps.maxAudioRefs = maxAudios;
  }

  return caps;
}

/** Presence-flag capability keys where a written `false` means the same as an
 * omitted key ("does not accept references"). The seed is inconsistent — some rows
 * write `reference:false`, others omit it — so parity collapses false ≡ absent for
 * these, matching how `deriveCatalogCapabilities` only ever emits them when true. */
const PRESENCE_FLAG_KEYS: ReadonlySet<RegistryManagedCapabilityKey> = new Set([
  'reference',
  'multi_image',
]);

/** Pick only the registry-managed keys from a catalog `capabilities` bag, so the
 * parity guard compares like-for-like and ignores routing/pricing fields. */
export function pickManagedCapabilities(
  capabilities: Record<string, unknown> | null | undefined,
): Partial<Record<RegistryManagedCapabilityKey, unknown>> {
  const bag = capabilities ?? {};
  const out: Partial<Record<RegistryManagedCapabilityKey, unknown>> = {};
  for (const key of REGISTRY_MANAGED_CAPABILITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(bag, key)) continue;
    if (PRESENCE_FLAG_KEYS.has(key) && bag[key] === false) continue;
    // Zero maxima mean the channel is unavailable and are omitted by the route
    // derivation, which emits maxima only for positive limits.
    if ((key === 'maxRefs' || key === 'maxVideoRefs' || key === 'maxAudioRefs') && bag[key] === 0)
      continue;
    out[key] = bag[key];
  }
  return out;
}

/** Find the contract for a specific gateway in a model's route set. */
export function contractForGateway(
  contracts: readonly ModelGatewayContract[],
  gateway: ContractGateway,
): ModelGatewayContract | undefined {
  return contracts.find((c) => c.gateway === gateway);
}

/** The normalized video parameter surface a route serializes. Only the fields the
 * contract actually exposes are present; a field the route omits stays absent. */
export interface NormalizedVideoParams {
  resolution?: string;
  aspectRatio?: string;
  duration?: number;
  /** Present only when the route accepts a real generate_audio toggle. */
  generateAudio?: boolean;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedVideoParams }
  | { ok: false; error: string };

/** Unique rejection sentinel — a Symbol, so it can never collide with a legit
 * passthrough string value that happens to equal a word like "REJECT". */
const ENUM_REJECT = Symbol('enum-reject');
/** Omit sentinel, distinct from `undefined` so the type stays a clean union. */
const ENUM_OMIT = Symbol('enum-omit');

/** Orientation-aware nearest-value snap for aspect-ratio menus, matching the kie
 * adapters' omniAspectRatio: a requested `w:h` maps to the route's portrait value
 * when h>w, else its landscape value; a non-ratio string falls to landscape. Only
 * meaningful for `w:h` enums (the only routes that declare onInvalid:'snap'). */
function orientationSnap(values: readonly string[], requested: string): string {
  const ratio = (v: string): [number, number] | null => {
    const m = v.match(/^(\d+):(\d+)$/);
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    return w > 0 && h > 0 ? [w, h] : null;
  };
  const portrait = values.find((v) => {
    const r = ratio(v);
    return r ? r[0] < r[1] : false;
  });
  const landscape = values.find((v) => {
    const r = ratio(v);
    return r ? r[0] >= r[1] : false;
  });
  const req = ratio(requested);
  if (req && req[0] < req[1]) return portrait ?? landscape ?? values[0]!;
  return landscape ?? portrait ?? values[0]!;
}

function normalizeEnum(
  param: EnumParamContract,
  requested: unknown,
): string | typeof ENUM_OMIT | typeof ENUM_REJECT {
  const has = typeof requested === 'string' && requested.length > 0;
  if (!has) return param.default; // absent → default; the field is still emitted
  const value = requested as string;
  // Per-value hard rejects win over everything (e.g. veo 4K — unwired, unpriced).
  if (param.reject?.some((r) => r.toLowerCase() === value.toLowerCase())) return ENUM_REJECT;
  if ((param.values as readonly string[]).includes(value)) return value;
  switch (param.onInvalid) {
    case 'reject':
      return ENUM_REJECT;
    case 'omit':
      return ENUM_OMIT;
    case 'passthrough':
      return value;
    case 'snap':
      return orientationSnap(param.values as readonly string[], value);
    case 'default':
    default:
      return param.default;
  }
}

/**
 * Normalize a requested video-param bag against ONE route contract — the single
 * snap/floor/reject policy that adapters AND the billing selector will both call
 * (execution plan Phase 2). Deliberately the CORRECTED semantics, not a bug-for-bug
 * copy of today's adapters: duration uses `Math.ceil` (matching the billing unit
 * rule in unitsForGenerationModel) so BILLED == SERVED, where the OpenRouter adapter
 * currently `Math.round`s — that latent charge/deliver skew is closed here, not
 * preserved. Wiring adapters to this is the next step, guarded by its own test.
 */
export function normalizeVideoParams(
  contract: ModelGatewayContract,
  params: Record<string, unknown>,
): NormalizeResult {
  const out: NormalizedVideoParams = {};

  if (contract.resolution) {
    const r = normalizeEnum(contract.resolution, params['resolution']);
    if (r === ENUM_REJECT) {
      return { ok: false, error: `resolution '${String(params['resolution'])}' not accepted` };
    }
    if (r !== ENUM_OMIT) out.resolution = r;
  }

  if (contract.aspectRatio) {
    const a = normalizeEnum(contract.aspectRatio, params['aspect_ratio']);
    if (a === ENUM_REJECT) {
      return { ok: false, error: `aspect_ratio '${String(params['aspect_ratio'])}' not accepted` };
    }
    if (a !== ENUM_OMIT) out.aspectRatio = a;
  }

  // The legacy `-1` sentinel means "let the model decide the duration" — the route
  // sends NO duration and there is nothing to bill. Omit it (leaving out.duration
  // undefined) so the serializer and the billing selector agree: a model-decides job
  // is not charged by duration, matching unitsForGenerationModel rejecting duration<=0.
  if (contract.duration && params['duration_seconds'] !== -1) {
    const d = contract.duration;
    const raw = Number(params['duration_seconds']);
    // ceil aligns with the billing unit rule so we never deliver fewer seconds than billed.
    let n = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : d.default;
    if (n < d.min) {
      if (d.onBelowMin === 'reject') {
        return { ok: false, error: `duration ${n}s below minimum ${d.min}s` };
      }
      n = d.min;
    }
    if (n > d.max) {
      if (d.onAboveMax === 'reject') {
        return { ok: false, error: `duration ${n}s exceeds maximum ${d.max}s` };
      }
      n = d.max;
    }
    // A snapping route (no intermediate values) maps down to the largest step ≤ n.
    if (!d.acceptsIntermediate && d.steps && d.steps.length > 0) {
      const atOrBelow = d.steps.filter((s) => s <= n);
      n = atOrBelow.length ? Math.max(...atOrBelow) : Math.min(...d.steps);
    }
    out.duration = n;
  }

  // generate_audio is a real request field ONLY where the route exposes the control.
  if (contract.audio.control) {
    out.generateAudio = params['generate_audio'] !== false;
  }

  return { ok: true, value: out };
}
