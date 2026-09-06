import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb, expiredPriceObligationForPoint, modelPricePoints } from '@seed/db';
import {
  pointServesMode,
  pointServesReferenceCount,
  resolveParametricPrice,
  type PricePoint,
  type PricePointSelector,
} from '@seed/credits';
import {
  billableVideoUnitsForModel,
  byteplusRouteContracts,
  priceModeForRequest,
  priceResolutionForRequest,
} from '@seed/shared';
import { unitsForModel } from './units';

export { priceModeForRequest } from '@seed/shared';

/**
 * Parametric charge resolver — the single price authority shared by the job
 * estimate, the job charge, and (via the persisted effective per-image rate) the worker
 * settlement, so estimate == charge == settlement by construction.
 *
 * A price we do not hold is REFUSED, never substituted. Two stable codes:
 * `price_unavailable` (no usable active row for a config we sell — our data is
 * broken, fix the table) and `config_not_available` (rows exist but none prices
 * the requested config — the no-silent-downgrade hard cap). Both surface as a
 * 400 from POST /v1/jobs and /v1/jobs/estimate. Output units come
 * from the model's registry route contract when it has one (billableVideoUnitsForModel),
 * else from `unitsForModel` (vendor floor + ceiling applied). Deriving both billing and
 * serialization from the ONE normalizer is what makes billed == served: it holds today
 * for routes whose adapter is wired to it (Seedance on OpenRouter) and for kie routes
 * whose serializer ceils (Wan, and — since 9f2d4c1 — veo/grok too: kie-adapter.ts
 * duration builders all use Math.ceil, matching billing). The remaining gap is only that
 * the kie builders do not yet literally CALL normalizeVideoParams. With-video
 * requests without a trusted input duration are refused; client duration fields
 * are never billing inputs.
 */

type Database = typeof defaultDb;

export interface JobPriceModel {
  id: string;
  kind: string;
  maxDurationSeconds: number | null;
  /** Vendor floor — smallest billable clip length (min of capabilities.durations). */
  minDurationSeconds?: number | null;
  /** Model capability bag; explicit `resolutions: []` means no resolution control. */
  capabilities?: Record<string, unknown> | null;
}

export interface ResolvedJobPrice {
  /** Credits to reserve/charge. */
  cost: number;
  /** Billed units (video seconds or image count). */
  units: number;
  /** Effective per-image rate to persist for settlement parity; null for video. */
  imageUnitCredits: number | null;
  source: 'parametric';
}

export type ResolveJobPriceResult =
  | { ok: true; price: ResolvedJobPrice }
  | { ok: false; error: string };

function firstString(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Count the image references the image adapter will actually receive. Explicit
 * `imageUrls` wins over the persisted reference-assets channel, matching the
 * kie serializer; otherwise video-looking persisted assets are excluded from
 * the image count. The model row's `capabilities.maxRefs` is the upper bound.
 *
 * The clamp is a PRICE floor-guard, not a policy: the routes refuse an over-cap
 * request outright (`too_many_references`), because nothing enforces the cap on the
 * way out and a count we clamp is a count we then fail to bill for.
 */
export function referenceImageCountForPricing(
  params: Record<string, unknown>,
  referenceAssets: readonly string[] = [],
  capabilities?: Record<string, unknown> | null,
): number {
  const imageUrls = params['imageUrls'];
  const requestedCount = Array.isArray(imageUrls)
    ? (() => {
        const validImageUrls = imageUrls.filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        );
        return validImageUrls.length > 0
          ? validImageUrls.length
          : referenceAssets.filter((url) => !/\.(mp4|mov|webm)(\?|$)/i.test(url)).length;
      })()
    : referenceAssets.filter((url) => !/\.(mp4|mov|webm)(\?|$)/i.test(url)).length;
  const maxRefs = maxReferenceCountFromCapabilities(capabilities);
  return maxRefs === null ? requestedCount : Math.min(requestedCount, maxRefs);
}

function maxReferenceCountFromCapabilities(
  capabilities: Record<string, unknown> | null | undefined,
): number | null {
  const advertisedMaxRefs = capabilities?.['maxRefs'];
  return typeof advertisedMaxRefs === 'number' && Number.isFinite(advertisedMaxRefs)
    ? Math.max(0, Math.floor(advertisedMaxRefs))
    : null;
}

export function clampReferenceCountToModel(
  referenceCount: number,
  capabilities: Record<string, unknown> | null | undefined,
): number {
  const maxRefs = maxReferenceCountFromCapabilities(capabilities);
  return maxRefs === null ? referenceCount : Math.min(referenceCount, maxRefs);
}

function declaredResolutions(
  capabilities: Record<string, unknown> | null | undefined,
): string[] | null {
  if (!capabilities || !Array.isArray(capabilities['resolutions'])) return null;
  return capabilities['resolutions'].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * Map request params to a price-point selector.
 * - resolution: `resolution` (the provider's rendered value) or image `quality`
 *   (Generate legacy). Image `size` is an aspect ratio and is never a price
 *   dimension. If both aliases arrive, resolution wins to match normalization.
 * - videoInput: a request carries video input when it ships `videoUrls`; it
 *   selects the corresponding parametric row and never reads client duration.
 * - audio is intentionally omitted from client params. The resolver below uses
 *   the sole active audio state stored for the requested config; two states are
 *   ambiguous and refused rather than selected by a non-existent client lever.
 */
export function priceSelectorFromParams(
  params: Record<string, unknown>,
  capabilities?: Record<string, unknown> | null,
  kind?: string,
): PricePointSelector {
  const resolutions = declaredResolutions(capabilities);
  // Video providers render `resolution` (or their own default) and IGNORE a
  // `quality` field, so `quality` must never be a video resolution alias — else a
  // crafted `{quality:'480p'}` with no `resolution` underbills a 720p render.
  // Image `quality` (1K/2K/4K) IS the price dimension, so images keep the alias.
  // An explicit empty capability list is a contract, not missing metadata: the
  // provider renders its own default regardless of a crafted quality/resolution
  // field. This also prevents a cheap legacy `quality=low` from buying a model's
  // real default output for less than its default row.
  const resolution = priceResolutionForRequest(params, capabilities, kind);
  const videoUrls = params['videoUrls'];
  const videoInput = Array.isArray(videoUrls) && videoUrls.length > 0;
  // Audio is a price dimension AND, on some models, a user lever. Where the
  // catalogue declares `audio: true` without explicitly disabling `audioControl`,
  // the request decides it, and the two states are two different configurations
  // at two different vendor rates (Kling: $0.126 per second with, $0.084 without).
  // A fixed-audio model (`audioControl:false`) still emits sound but ignores the
  // request flag; the resolver must not let a crafted flag select a hidden cheap
  // row if finance ever carries both states for that model.
  //
  // The default is ON, because that is what the adapter sends: the OpenRouter
  // body-builder defaults `generate_audio` to true, so an absent field bills the
  // rate that will actually run. Defaulting the other way would quote the quiet
  // price for a job rendered with sound.
  const audioLever = capabilities?.['audio'] === true && capabilities?.['audioControl'] !== false;
  if (!audioLever) return { resolution, videoInput };
  const requested = params['generate_audio'];
  return { resolution, videoInput, audio: requested !== false };
}

export function requiresVideoResolution(
  model: Pick<JobPriceModel, 'kind' | 'capabilities'>,
): boolean {
  return model.kind === 'video' && (declaredResolutions(model.capabilities)?.length ?? 0) > 0;
}

export function validateVideoResolution(
  model: Pick<JobPriceModel, 'kind' | 'capabilities'>,
  params: Record<string, unknown>,
): Extract<ResolveJobPriceResult, { ok: false }> | null {
  if (requiresVideoResolution(model) && !firstString(params, ['resolution'])) {
    return { ok: false, error: 'resolution_required' };
  }
  return null;
}

function selectorIsDeclared(
  selector: PricePointSelector,
  capabilities: Record<string, unknown> | null | undefined,
): boolean {
  const resolutions = declaredResolutions(capabilities);
  return (
    resolutions === null || resolutions.length === 0 || resolutions.includes(selector.resolution)
  );
}

/** Min billable clip length = smallest of `capabilities.durations` (the vendor floor). */
export function minBillableDurationSeconds(capabilities: unknown): number {
  const safeDefault = 4;
  if (!capabilities || typeof capabilities !== 'object') return safeDefault;
  const durations = (capabilities as Record<string, unknown>)['durations'];
  if (!Array.isArray(durations)) return safeDefault;
  const nums = durations.filter(
    (x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0,
  );
  return nums.length > 0 ? Math.min(...nums) : safeDefault;
}

const POINT_COLUMNS = {
  modelId: modelPricePoints.modelId,
  resolution: modelPricePoints.resolution,
  videoInput: modelPricePoints.videoInput,
  audio: modelPricePoints.audio,
  unitKind: modelPricePoints.unitKind,
  baseCredits: modelPricePoints.baseCredits,
  baseUnits: modelPricePoints.baseUnits,
  // Load-bearing: without this column the kernel prorates a row that is priced for the
  // whole clip, and a 4-second Veo bills half of a cost we pay in full. The column is
  // the ONLY thing that distinguishes the two, so omitting it from the projection is a
  // silent undercharge rather than a type error.
  flatRate: modelPricePoints.flatRate,
  perItem: modelPricePoints.perItem,
  // The two dimensions rev. 10/11 price that the old four-column key cannot say.
  // Same load-bearing warning as `flatRate` above: a column missing from the
  // projection reads as «this row matches everything», so the kernel would hand
  // an i2v request the cheaper t2v row and a 2-reference job the 0–1 price. That
  // is a silent undercharge, not a type error.
  mode: modelPricePoints.mode,
  refsMin: modelPricePoints.refsMin,
  refsMax: modelPricePoints.refsMax,
} as const;

/**
 * Expired finance rulings are a runtime refusal, not a silent continuation of
 * the old tariff. Keep the database/seed row intact until finance decides what
 * to do, but remove the exact affected selector from the derived active set so
 * estimates and submits return `price_unavailable` instead of charging a stale
 * premium. Other valid rows for the same model remain sellable.
 */
export function filterExpiredPricePoints(
  points: readonly PricePoint[],
  now: Date = new Date(),
): PricePoint[] {
  return points.filter((point) => !expiredPriceObligationForPoint(point, now));
}

/** Active price points for one model. */
export async function loadActivePricePoints(
  modelId: string,
  database: Database = defaultDb,
): Promise<PricePoint[]> {
  const rows = await database
    .select(POINT_COLUMNS)
    .from(modelPricePoints)
    .where(and(eq(modelPricePoints.modelId, modelId), eq(modelPricePoints.isActive, true)));
  return filterExpiredPricePoints(rows as PricePoint[]);
}

/** Active price points for many models, grouped by model id (one query). */
export async function loadActivePricePointsByModel(
  modelIds: readonly string[],
  database: Database = defaultDb,
): Promise<Map<string, PricePoint[]>> {
  const grouped = new Map<string, PricePoint[]>();
  if (modelIds.length === 0) return grouped;
  const rows = await database
    .select(POINT_COLUMNS)
    .from(modelPricePoints)
    .where(
      and(inArray(modelPricePoints.modelId, [...modelIds]), eq(modelPricePoints.isActive, true)),
    );
  for (const row of filterExpiredPricePoints(rows as PricePoint[])) {
    const list = grouped.get(row.modelId);
    if (list) list.push(row);
    else grouped.set(row.modelId, [row]);
  }
  return grouped;
}

/**
 * Resolve a job's price against an already-loaded set of active price points —
 * pure apart from `unitsForModel`. Used by the multi-model estimate loop so it
 * batch-loads points once instead of querying per candidate.
 */
export function resolveJobPriceFromPoints(
  model: JobPriceModel,
  params: Record<string, unknown>,
  activePoints: readonly PricePoint[],
  referenceCount?: number,
): ResolveJobPriceResult {
  // Output units, floored to the vendor minimum clip and capped at the maximum.
  // For a model with a registry route contract, DERIVE the billable seconds from the
  // same normalizer the adapter serializes with (billableVideoUnitsForModel), so the
  // priced selector matches the served one — billed == served (DoD 3). This bills the
  // PRIMARY route (the leg that serves unless failover); a snapping/rejecting fallback
  // is the route-aware downgrade concern (Phase 3/5), not a reason to bill differently.
  // Uncovered models keep the legacy `unitsForModel` computation unchanged.
  const registryContracts = model.kind === 'video' ? byteplusRouteContracts[model.id] : undefined;
  const u = registryContracts
    ? billableVideoUnitsForModel(registryContracts, params)
    : unitsForModel({
        kind: model.kind,
        params,
        maxDurationSeconds: model.maxDurationSeconds ?? null,
        minDurationSeconds: model.minDurationSeconds ?? null,
      });
  if (!u.ok) return { ok: false, error: u.error };

  // The reference count and the mode are computed BEFORE the audio inference,
  // because that inference has to look at the same candidate rows the kernel will:
  // once two rows differ only by mode or band, «the audio states available for this
  // request» is a different set per mode, and inferring it across all of them either
  // refuses a resolvable price as ambiguous or picks a state from a row that could
  // never serve this request.
  const pricedReferenceCount =
    referenceCount == null
      ? referenceImageCountForPricing(params, [], model.capabilities)
      : clampReferenceCountToModel(referenceCount, model.capabilities);
  const mode = priceModeForRequest(model, params, pricedReferenceCount);
  const requestedSelector: PricePointSelector = {
    ...priceSelectorFromParams(params, model.capabilities, model.kind),
    mode,
  };
  // A request that DECIDES its own audio state needs no inference — and must not be
  // overridden by it. The inference below exists for models where audio is not a
  // user lever; running it on one where it is would collapse two real prices into
  // whichever state happens to be seeded, or refuse both as ambiguous.
  const audioStates = new Set(
    activePoints
      .filter(
        (point) =>
          point.resolution === requestedSelector.resolution &&
          point.videoInput === (requestedSelector.videoInput ?? false) &&
          pointServesMode(point, mode) &&
          pointServesReferenceCount(point, pricedReferenceCount),
      )
      .map((point) => point.audio),
  );
  // Audio describes the finance configuration but is not a user-facing price
  // selector. Exactly one active state is therefore resolvable. Multiple states
  // would expose two prices for the same request shape, so fail closed.
  // The request decides its own audio state ONLY where the price table offers a
  // real choice — both states priced for this rung. Anywhere else the column
  // merely labels finance's configuration, and honouring a `generate_audio` the
  // table has no row for would refuse a price the model renders perfectly well.
  // That is not hypothetical: seedance declares an audio lever and is priced on
  // audio=false rows alone, so a request without the flag would have found nothing.
  const requestChoosesAudio = requestedSelector.audio !== undefined && audioStates.size > 1;
  if (!requestChoosesAudio && audioStates.size > 1) {
    return { ok: false, error: 'price_unavailable' };
  }
  const resolvedAudio = requestChoosesAudio
    ? requestedSelector.audio
    : audioStates.size === 1
      ? [...audioStates][0]
      : undefined;
  const selector: PricePointSelector = {
    ...requestedSelector,
    ...(resolvedAudio === undefined ? {} : { audio: resolvedAudio }),
  };
  const units = u.units;

  if (!selectorIsDeclared(selector, model.capabilities)) {
    return { ok: false, error: 'config_not_available' };
  }
  const resolved = resolveParametricPrice(activePoints, selector, units, pricedReferenceCount);
  // A price we cannot resolve is a refusal the caller turns into a 400, never a
  // silent substitution: `price_unavailable` means our table is missing/broken
  // for a config we sell, `config_not_available` means the ladder deliberately
  // does not carry it.
  if (!resolved.ok) return { ok: false, error: resolved.error };

  return {
    ok: true,
    price: {
      cost: resolved.price.cost,
      units,
      imageUnitCredits: resolved.price.imageUnitCredits,
      source: resolved.price.source,
    },
  };
}

/**
 * Does this model's price table make the reference COUNT a price dimension?
 *
 * Only where it does can an over-cap request cost us money we did not charge for:
 * a banded row prices «2–10 references» and a per-item term meters each extra image,
 * so sending more than we priced is a bill for a job we did not sell. Everywhere
 * else the count buys nothing — the vendor charges per OUTPUT image — and clamping
 * an over-cap request to what the model can use is what we have always done, and
 * what the pickers still let a user ask for.
 */
export function referenceCountIsPriced(points: readonly PricePoint[]): boolean {
  return points.some((point) => (point.refsMin ?? 0) > 0 || point.perItem != null);
}

export interface ReferenceCapRefusal {
  requestedReferenceCount: number;
  maxReferenceCount: number;
}

/**
 * The over-cap refusal, or `null` when the request is priceable as asked.
 *
 * `effectiveReferenceCount` is what the SUBMIT will carry — on the estimate that
 * includes the pending ones, or the two endpoints refuse different requests and a
 * board quotes a price its own submit rejects.
 */
export function referenceCapRefusal(
  effectiveReferenceCount: number,
  capabilities: Record<string, unknown> | null | undefined,
  points: readonly PricePoint[],
): ReferenceCapRefusal | null {
  const maxReferenceCount = clampReferenceCountToModel(effectiveReferenceCount, capabilities);
  if (maxReferenceCount >= effectiveReferenceCount) return null;
  if (!referenceCountIsPriced(points)) return null;
  return { requestedReferenceCount: effectiveReferenceCount, maxReferenceCount };
}

/** User-facing RU text for a request that carries more references than we can price. */
export function referenceCapMessage(maxReferenceCount: number): string {
  return maxReferenceCount === 0
    ? 'Эта модель не принимает референсы — убери вложенные изображения.'
    : `Эта модель принимает не больше ${maxReferenceCount} референсов — убери лишние изображения.`;
}

/**
 * User-facing RU text for a price refusal, so every surface says the same thing
 * and the client never has to guess from a bare machine code. Returned alongside
 * the stable `error` code by POST /v1/jobs and /v1/jobs/estimate.
 */
export function priceRefusalMessage(code: string): string | null {
  if (code === 'config_not_available') {
    return 'Эта конфигурация недоступна для выбранной модели — измени разрешение или длительность.';
  }
  if (code === 'price_unavailable') {
    return 'Для этой конфигурации нет цены — мы не можем посчитать стоимость. Выбери другие параметры или напиши нам.';
  }
  if (code === 'resolution_required') {
    return 'Для выбранной видеомодели укажи разрешение.';
  }
  return null;
}

/** Resolve a single job's price, loading its active price points from the DB. */
export async function resolveJobPrice(
  model: JobPriceModel,
  params: Record<string, unknown>,
  database: Database = defaultDb,
  referenceCount?: number,
): Promise<ResolveJobPriceResult> {
  const points = await loadActivePricePoints(model.id, database);
  return resolveJobPriceFromPoints(model, params, points, referenceCount);
}
