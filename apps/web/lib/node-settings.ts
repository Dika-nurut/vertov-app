/**
 * Per-node settings for a «generate» shot — the model + the clip/image
 * params that used to be hardcoded in `runNodeRef` (P9 of the canvas-parity
 * campaign). Everything here is PURE so it's unit-testable in isolation; the
 * board component reads `data` off the node and fills gaps through the shared
 * Board contract. `buildJobParams` is retained as a compatibility wrapper;
 * the graph runner uses the registry-owned strict compiler directly.
 *
 * Backward-compat: any setting absent from a saved board collapses to the
 * value the old hardcoded path used (5s · 720p · adaptive · audio-on · 1:1 ·
 * 2K), so existing boards behave identically until the user touches a gear.
 */
import {
  BOARD_GENERATE_DEFAULTS,
  BOARD_IMAGE_ASPECTS,
  BOARD_IMAGE_QUALITIES,
  BOARD_VIDEO_ASPECTS,
  BOARD_VIDEO_RESOLUTIONS,
  boardImageAspectsFor,
  boardImageQualitiesFor,
  boardVideoAspectsFor,
  boardVideoDurationsFor,
  boardVideoResolutionsFor,
  compileBoardGenerationQuote,
  compileBoardGenerationRequest,
  isBoardModelCatalogComplete,
  resolveBoardImageSettings,
  resolveBoardModelContract,
  resolveBoardVideoSettings,
  type BoardGenerateData,
  type BoardCompiledFrameImage,
  type BoardResolvedImageSettings,
  type BoardResolvedVideoSettings,
} from '@seed/shared/board-contract';
import { isModelLocked, tierRank, type PlanTier } from './model-tier';

/** Aspect ratios the Evolink video adapter accepts (`VIDEO_RATIOS`). */
export type VideoAspect = (typeof BOARD_VIDEO_ASPECTS)[number];
export const VIDEO_ASPECTS: VideoAspect[] = [...BOARD_VIDEO_ASPECTS];

/** Video resolutions the adapter passes through as `quality`. */
export type VideoResolution = (typeof BOARD_VIDEO_RESOLUTIONS)[number];

/** Image aspect ratios Seedream accepts (`SEEDREAM_RATIOS` subset we expose). */
export type ImageAspect = (typeof BOARD_IMAGE_ASPECTS)[number];

/** Seedream image quality tiers (forwarded as `quality`, default 2K). */
export type ImageQuality = (typeof BOARD_IMAGE_QUALITIES)[number];

/** Inclusive clip-duration bounds the video adapter clamps to (4..15s). */
export const DURATION_MIN = 4;
export const DURATION_MAX = 15;

/**
 * Per-node settings persisted in the generate node's `data`. Every field is
 * optional so an older saved board (which has none of them) still loads; the
 * resolvers below substitute the legacy hardcoded default for any gap.
 */
export type NodeSettings = Pick<
  BoardGenerateData,
  | 'modelId'
  | 'durationSeconds'
  | 'videoResolution'
  | 'videoAspect'
  | 'generateAudio'
  | 'imageAspect'
  | 'imageQuality'
>;

/** The legacy hardcoded values — the back-compat floor for missing settings. */
export const DEFAULTS = {
  durationSeconds: BOARD_GENERATE_DEFAULTS.durationSeconds,
  videoResolution: BOARD_GENERATE_DEFAULTS.videoResolution,
  videoAspect: BOARD_GENERATE_DEFAULTS.videoAspect,
  generateAudio: BOARD_GENERATE_DEFAULTS.generateAudio,
  imageAspect: BOARD_GENERATE_DEFAULTS.imageAspect,
  imageQuality: BOARD_GENERATE_DEFAULTS.imageQuality,
} as const;

/** Resolved (no-optionals) video settings. */
export type ResolvedVideoSettings = BoardResolvedVideoSettings;
/** Resolved (no-optionals) image settings. */
export type ResolvedImageSettings = BoardResolvedImageSettings;

/** The resolution tiers a model offers (capability-driven, else the static
 *  Seedance set). Filtered to the tiers the board control + adapter understand. */
export function videoResolutionsFor(model: ModelLike | undefined): VideoResolution[] {
  return boardVideoResolutionsFor(model);
}

/** The aspect ratios a model offers + «авто» (capability-driven, else static). */
export function videoAspectsFor(model: ModelLike | undefined): VideoAspect[] {
  return boardVideoAspectsFor(model);
}

/** The discrete durations a model offers, or null when continuous (Seedance). */
export function videoDurationsFor(model: ModelLike | undefined): number[] | null {
  return boardVideoDurationsFor(model);
}

/** Image controls are explicit per model. An empty array means the provider
 * fixes or chooses that setting, so the Board must not offer it. */
export function imageAspectsFor(model: ModelLike | undefined): ImageAspect[] {
  return boardImageAspectsFor(model);
}

export function imageQualitiesFor(model: ModelLike | undefined): ImageQuality[] {
  return boardImageQualitiesFor(model);
}

/** Fill missing video settings with the legacy defaults, clamping/snapping to
 *  the model's declared option space when one is given. */
export function resolveVideoSettings(
  s: NodeSettings | undefined,
  model?: ModelLike,
): ResolvedVideoSettings {
  return resolveBoardVideoSettings(s ?? {}, model);
}

/** Fill missing image settings with the legacy defaults. */
export function resolveImageSettings(
  s: NodeSettings | undefined,
  model?: ModelLike,
): ResolvedImageSettings {
  return resolveBoardImageSettings(s ?? {}, model);
}

/**
 * Legacy params-only adapter. It delegates normalization to the shared compiler
 * but preserves the historical truncation behavior expected by older callers.
 * New graph code must call `compileBoardGenerationRequest` and handle rejection.
 */
export function buildJobParams(input: {
  mode: 'video' | 'image';
  settings: NodeSettings | undefined;
  images: string[];
  videos?: string[] | undefined;
  audios?: string[] | undefined;
  /** true for a `*-reference-to-video` model — switches the video body from
   * first/last frames to the cast-lock reference arrays. */
  reference?: boolean | undefined;
  count?: number | undefined;
  /** The resolved model — enables capability-aware clamping + frame slots. */
  model?: ModelLike | undefined;
}): Record<string, unknown> {
  let model: ModelLike =
    input.model ??
    (input.mode === 'video'
      ? {
          id: 'legacy-board-video',
          family: 'legacy',
          variant: 'video',
          kind: 'video',
          minUnitCredits: 0,
          capabilities: { audio: true },
        }
      : {
          id: 'legacy-board-image',
          family: 'legacy',
          variant: 'image',
          kind: 'image-edit',
          minUnitCredits: 0,
          capabilities: { reference: true, multi_image: true, maxRefs: 14 },
        });
  if (input.reference) {
    const { frames: _frames, ...capabilities } = model.capabilities ?? {};
    model = {
      ...model,
      capabilities: {
        ...capabilities,
        reference: true,
        maxRefs: 9,
        // A selected catalog row may deliberately withdraw a media channel for
        // pricing. Preserve an explicit zero rather than recreating a dead UI
        // affordance through this legacy reference-mode helper.
        maxVideoRefs: capabilities['maxVideoRefs'] ?? 3,
        maxAudioRefs: capabilities['maxAudioRefs'] ?? 3,
        audio: capabilities['audio'] ?? true,
      },
    };
  }
  const contract = resolveBoardModelContract(model)!;
  const result = compileBoardGenerationRequest({
    data: {
      mode: input.mode,
      prompt: '',
      count: Math.max(1, Math.min(4, input.count ?? 1)),
      status: 'idle',
      ...(input.settings ?? {}),
    },
    model,
    prompt: '',
    imageUrls: input.images
      .filter(Boolean)
      .slice(
        0,
        contract.referenceImageMax > 0 ? contract.referenceImageMax : contract.imageInput.max,
      ),
    videoUrls: (input.videos ?? []).filter(Boolean).slice(0, contract.videoReferenceMax),
    audioUrls: (input.audios ?? []).filter(Boolean).slice(0, contract.audioReferenceMax),
  });
  if (!result.ok) throw new Error(result.reason);
  const params = { ...result.request.params };
  const frames = params['frameImages'];
  if (Array.isArray(frames)) {
    params['imageUrls'] = frames.flatMap((frame) =>
      frame && typeof frame === 'object' && typeof frame.url === 'string' ? [frame.url] : [],
    );
    delete params['frameImages'];
  }
  return params;
}

export interface ModelLike {
  id: string;
  family: string;
  variant: string;
  kind: 'image' | 'image-edit' | 'video' | 'voice';
  /**
   * Cheapest per-unit credit rate across the model's active workbook rows, as
   * projected by /v1/models (`minUnitCredits`). Ordering-only: the actual charge
   * always comes from the estimate/submit price resolution.
   */
  minUnitCredits: number;
  maxDurationSeconds?: number | null;
  /**
   * Minimum plan tier required (P-B2/DEC-3). Absent on older API rows. Typed as
   * a plain string, not the tier union: this is whatever `/v1/models` returned,
   * and narrowing it here would force every caller to cast a DB `string | null`.
   * The entitlement helpers in `./model-tier` fail CLOSED on a tier they do not
   * recognise, so an unexpected value locks the model rather than unlocking it.
   */
  tierMin?: string | null;
  /** Synced OpenRouter option space — drives capability-aware clamping (S4). */
  capabilities?: Record<string, unknown> | null;
}

/**
 * Models a generate node of `mode` may pick from (video ⇒ video; image ⇒
 * image), cheapest-first so the picker reads sensibly.
 *
 * Out-of-plan models are deliberately KEPT here — the picker renders them
 * locked with an upsell (parity with /generate), it does not hide them. Use
 * `unlockedModelsForMode` wherever a default/fallback is picked.
 *
 * The `*-reference-to-video` twins are kept too. The base rows declare
 * `frames: ['first','last']` → `imageInput.role: 'frame'`, max 2, zero video/
 * audio reference capacity, while the twins declare `reference: true` →
 * `role: 'reference'`, max 9 + catalog-declared video/audio references
 * (packages/shared/src/board-contract.ts:886-915). Those contracts drive the
 * node's actual input PORTS (BoardNodes.tsx:1671-1697), so hiding a twin would
 * make cast-lock reference-to-video unreachable on boards.
 *
 * /generate now agrees (owner decision, 2026-07-25). It used to hide the twins
 * and swap to them on the mere PRESENCE of an attached asset — which made the
 * first/last-frame path unreachable on `seedance-2-0` and `seedance-2-0-fast`,
 * the two most-used video models, because the swap forced reference mode. The
 * twins are separate pickable cards there as well now (the card IS the mode
 * choice, there is no mode toggle), labelled «… · кадры» / «… · референсы»,
 * so both surfaces expose the same catalog rows with the same input contract —
 * see lib/generate-model-cards.ts and `videoMediaCaps` in lib/model-capabilities.ts,
 * which mirrors the board port derivation above.
 */
export function modelsForMode<T extends ModelLike>(models: T[], mode: 'video' | 'image'): T[] {
  return models
    .filter((m) => (mode === 'video' ? m.kind === 'video' : m.kind === 'image'))
    .filter((model) => isBoardModelCatalogComplete(model))
    .sort((a, b) => a.minUnitCredits - b.minUnitCredits);
}

/** The subset of `modelsForMode` the plan actually entitles. */
export function unlockedModelsForMode<T extends ModelLike>(
  models: T[],
  mode: 'video' | 'image',
  userTier: string | null | undefined,
): T[] {
  return modelsForMode(models, mode).filter((m) => !isModelLocked(m, userTier));
}

/**
 * The board's mode default. Prefers `preferredId` when the plan allows it, else
 * the cheapest model the plan can use, else — nothing usable at all, e.g. a
 * free user in video mode — the lowest-tier cheapest, which the node renders
 * LOCKED with an upsell. Mirrors GenerateClient's `defaultModel`
 * (GenerateClient.tsx:522-539) so a default can never silently land on a model
 * the user cannot run.
 */
export function defaultModelForMode<T extends ModelLike>(
  models: T[],
  mode: 'video' | 'image',
  preferredId: string,
  userTier: string | null | undefined,
): T | undefined {
  const eligible = modelsForMode(models, mode);
  const preferred = eligible.find((m) => m.id === preferredId);
  if (preferred && !isModelLocked(preferred, userTier)) return preferred;
  // `eligible` is already cheapest-first, so the first unlocked row is the
  // cheapest the plan can run.
  const usable = eligible.find((m) => !isModelLocked(m, userTier));
  if (usable) return usable;
  return [...eligible].sort(
    (a, b) => tierRank(a.tierMin) - tierRank(b.tierMin) || a.minUnitCredits - b.minUnitCredits,
  )[0];
}

/**
 * Resolve the model a node will actually use: the persisted `modelId` if it
 * still exists in the catalog for this mode, else the provided fallback
 * (the board's mode-default), else the first eligible model.
 *
 * A persisted pick resolves even when the plan no longer entitles it (a
 * downgrade must not silently rewrite a saved board) — the node renders it
 * locked and refuses to run. Callers keep defaults in-plan by passing a
 * `fallback` from `defaultModelForMode`.
 */
export function resolveModel<T extends ModelLike>(
  models: T[],
  mode: 'video' | 'image',
  modelId: string | undefined,
  fallback: T | undefined,
): T | undefined {
  const eligible = modelsForMode(models, mode);
  if (modelId) {
    const picked = eligible.find((m) => m.id === modelId);
    if (picked) return picked;
  }
  if (fallback && eligible.some((m) => m.id === fallback.id)) return fallback;
  return eligible[0];
}

/**
 * Compiled request shaped for `POST /v1/jobs/estimate`. The Board UI asks the
 * server — the same resolver a submit charges with — for the authoritative
 * price. Returns undefined for an invalid/incomplete node, which means no
 * displayed price and no runnable action.
 */
export interface NodeEstimateRequest {
  modelId: string;
  prompt: string;
  params: Record<string, unknown>;
  /**
   * Upstream stills that have not rendered yet: no URL to put in `params`, but
   * they will be sent, and a reference-band price counts them. Carried beside the
   * params rather than inside them because it is not a request parameter — it is
   * what the caller knows about a request it cannot fully write down yet.
   */
  pendingReferenceCount?: number;
  /**
   * The pending stills bound for a FRAME slot, kept apart from the reference count.
   * The API is sent their SUM — the server only needs to know an input image will
   * exist — but the local quote key needs the split, because the two land in
   * different fields of the compiled request.
   */
  pendingFrameCount?: number;
}

export function nodeEstimateRequest(input: {
  mode: 'video' | 'image';
  model: ModelLike | undefined;
  settings: NodeSettings | undefined;
  count?: number | undefined;
  /**
   * These are the media references and frame inputs the submitted request will
   * carry. They are included even when today's resolver does not price them:
   * reference count is becoming price-relevant, and an estimate that omits it
   * is not the request the runner compiles — the divergence the `expectedCost`
   * binding would turn into a 409.
   */
  videoUrls?: readonly string[] | undefined;
  imageUrls?: readonly string[] | undefined;
  frameImages?: readonly BoardCompiledFrameImage[] | undefined;
  pendingReferenceCount?: number | undefined;
  pendingFrameCount?: number | undefined;
}): NodeEstimateRequest | undefined {
  const m = input.model;
  if (!m) return undefined;
  const quote = compileBoardGenerationQuote({
    data: {
      mode: input.mode,
      prompt: '',
      count: Math.max(1, Math.min(4, input.count ?? 1)),
      status: 'idle',
      ...(input.settings ?? {}),
    },
    model: m,
    prompt: ' ',
    ...(input.imageUrls && input.imageUrls.length > 0 ? { imageUrls: input.imageUrls } : {}),
    ...(input.frameImages && input.frameImages.length > 0
      ? { frameImages: input.frameImages }
      : {}),
    ...(input.videoUrls && input.videoUrls.length > 0 ? { videoUrls: input.videoUrls } : {}),
  });
  if (!quote.ok) return undefined;
  return {
    ...quote.request,
    ...(input.pendingReferenceCount ? { pendingReferenceCount: input.pendingReferenceCount } : {}),
    ...(input.pendingFrameCount ? { pendingFrameCount: input.pendingFrameCount } : {}),
  };
}
