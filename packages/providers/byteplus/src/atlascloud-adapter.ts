import { AtlasCloudClient } from './atlascloud-client';
import {
  ProviderError,
  workflowFrameImages,
  workflowImageControls,
  type GenerationAsset,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';
import { extensionFromContentType, urlArr } from './adapter-helpers';

const POLL_CEILING_MS = 300_000; // videos can run a few minutes
const POLL_BACKOFF_MS = [2_000, 3_000, 5_000, 8_000, 12_000] as const;

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Read a string[] from params (filters to non-empty strings). */
// ---------------------------------------------------------------------------
// Model-id mapping: our `models` rows → AtlasCloud's namespaced ids.
// This is a GATEWAY switch, not a model switch — same logical Seedream/Seedance
// models, routed to AtlasCloud's best-parity equivalents (seedance-2.0 family,
// seedream-v4.5 family). See docs/platform/model-catalog.md.
// ---------------------------------------------------------------------------

/** Allowed AtlasCloud video `ratio` values (note: NOT `aspect_ratio`). */
const VIDEO_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'];

/** Provider parser ladder. SR values are not an offered product capability; see QE-1. */
const SEEDANCE_RES = ['480p', '720p', '720p-SR', '1080p', '1080p-SR', '1440p-SR'];
/** Provider parser ladder for fast variants; SR values are not offered (QE-1). */
const SEEDANCE_FAST_RES = ['480p', '720p', '720p-SR', '1080p-SR', '1440p-SR'];

/** Seedream v4.5 accepts only this fixed pixel-size enum. */
const SEEDREAM_SIZES = [
  '2048*2048',
  '2304*1728',
  '1728*2304',
  '2848*1600',
  '1600*2848',
  '2496*1664',
  '1664*2496',
  '3136*1344',
  '4096*4096',
  '4704*3520',
  '3520*4704',
  '5504*3040',
  '3040*5504',
  '4992*3328',
  '3328*4992',
  '6240*2656',
] as const;

/**
 * Map our `size` param (a ratio like "16:9", or a pixel string like "1024x1024")
 * to the nearest AtlasCloud Seedream pixel-size enum entry, chosen by aspect
 * ratio. AtlasCloud rejects sizes outside its enum, so we always snap.
 */
export function imageSizeToPixels(size: string, resolution: '1K' | '2K' | '4K' = '2K'): string {
  let target: number;
  const ratioM = /^(\d+):(\d+)$/.exec(size);
  const pxM = /^(\d+)[x*](\d+)$/.exec(size);
  if (ratioM) {
    target = Number(ratioM[1]) / Number(ratioM[2]);
  } else if (pxM) {
    target = Number(pxM[1]) / Number(pxM[2]);
  } else {
    target = 1; // unknown → square
  }
  // AtlasCloud's current Seedream enum has 2K-ish and 4K-ish ladders. A 1K
  // legacy request uses the smallest accepted tier rather than an invalid size.
  const candidates = resolution === '4K' ? SEEDREAM_SIZES.slice(8) : SEEDREAM_SIZES.slice(0, 8);
  let best = candidates[0] as string;
  let bestDelta = Infinity;
  for (const s of candidates) {
    const m = /^(\d+)\*(\d+)$/.exec(s)!;
    const r = Number(m[1]) / Number(m[2]);
    const delta = Math.abs(Math.log(r / target));
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return best;
}

type VideoMode = 'text-to-video' | 'image-to-video' | 'reference-to-video';

/** Infer the seedance mode + speed exactly the way Evolink does (from the
 * provider model id), so the gateway switch keeps the same mode decision. */
function seedanceModelId(
  spec: WorkflowSpec,
  hasImageInput: boolean,
): { id: string; mode: VideoMode; fast: boolean } {
  const probe = `${spec.providerModelId} ${spec.modelId}`;
  const fast = /fast/i.test(probe);
  let mode: VideoMode = 'text-to-video';
  if (/image-to-video/i.test(probe)) mode = 'image-to-video';
  else if (/reference-to-video/i.test(probe)) mode = 'reference-to-video';
  // Mode follows the input (mirrors the Evolink adapter): a frame attached to
  // a text-to-video model upgrades it to image-to-video («Оживить» flow).
  else if (hasImageInput) mode = 'image-to-video';
  const family = fast ? 'seedance-2.0-fast' : 'seedance-2.0';
  return { id: `bytedance/${family}/${mode}`, mode, fast };
}

/** Map an image job to the right seedream-v4.5 variant by mode + batch size. */
function seedreamModelId(hasRefs: boolean, n: number): string {
  if (hasRefs && n > 1) return 'bytedance/seedream-v4.5/edit-sequential';
  if (hasRefs) return 'bytedance/seedream-v4.5/edit';
  if (n > 1) return 'bytedance/seedream-v4.5/sequential';
  return 'bytedance/seedream-v4.5';
}

const OMNI_DURATIONS = [4, 6, 8, 10];
const OMNI_RESOLUTIONS = ['720p', '1080p', '4k'];

/**
 * A PRICED CONSTANT, not a URL detail. Read this before touching it.
 *
 * AtlasCloud publishes Gemini Omni in two tiers. The `-developer` routes bill
 * `$0,112` per second; the STANDARD routes bill `$0,125–0,135`. Finance signs the
 * omni reserve leg at 273 credits against `$0,112`, which clears the zero floor by
 * **+0,25%**. On the standard route the same 273 credits is **−11,3%**.
 *
 * So this six-character suffix is the only thing holding a leg above water, and it is
 * the one margin input in the whole catalogue that is not a vendor rate, an FX figure,
 * or a price — it is OUR OWN string. Nothing outside this repo would signal its loss:
 * no invoice changes shape, no vendor announcement fires, the calls keep succeeding and
 * returning video. It would simply cost more than we charge, silently.
 *
 * Finance asked for it to be pinned somewhere a refactor cannot quietly drop it
 * (rev. 13, «пожалуйста, считайте эту строку тарифицируемой константой»). Guarded in
 * `atlascloud-omni-priced-route.test.ts` against all three modes.
 */
export const ATLAS_OMNI_PRICED_ROUTE_SUFFIX = '-developer';

/** Snap a requested duration to the nearest supported Gemini Omni Flash tier. */
function snapOmniDuration(requested: number): number {
  return OMNI_DURATIONS.reduce((best, d) =>
    Math.abs(d - requested) < Math.abs(best - requested) ? d : best,
  );
}

/** Gemini Omni Flash on AtlasCloud — real schema confirmed live 2026-07-02
 * via our own account (`/api/v1/model/generateVideo`, model ids
 * `google/gemini-omni-flash/{text,image,reference}-to-video-developer`).
 * NOT the Seedance/Seedream family this file otherwise targets — a distinct
 * model, real per-second base_price confirmed via our AtlasCloud API key
 * (0.112 for image-to-video), not yet cross-checked across all three
 * resolution tiers (720p/1080p/4k) — the same flat-vs-tiered risk we found
 * with Sora, not assumed away here. */
function buildGeminiOmniRequest(spec: WorkflowSpec, imageUrls: string[]): AtlasBuildResult {
  const p = spec.params;
  const isReference = /reference-to-video/i.test(spec.providerModelId);
  const mode = isReference
    ? 'reference-to-video'
    : imageUrls.length
      ? 'image-to-video'
      : 'text-to-video';
  const duration = snapOmniDuration(Math.round(asNum(p['duration_seconds'], 8)));
  const aspectRatio = p['aspect_ratio'] === '9:16' ? '9:16' : '16:9';
  let resolution = asStr(p['resolution'], '720p');
  if (!OMNI_RESOLUTIONS.includes(resolution)) resolution = '720p';

  const body: Record<string, unknown> = {
    model: `google/gemini-omni-flash/${mode}${ATLAS_OMNI_PRICED_ROUTE_SUFFIX}`,
    prompt: spec.prompt,
    duration,
    aspect_ratio: aspectRatio,
    resolution,
  };
  if (imageUrls.length) body['images'] = imageUrls.slice(0, 7);
  if (typeof p['seed'] === 'number') body['seed'] = p['seed'];
  return { path: '/model/generateVideo', body };
}

export interface AtlasBuildResult {
  path: string;
  body: Record<string, unknown>;
}

/** Build the AtlasCloud submit path + body for a workflow spec. Exported for
 * tests (charge==delivery, field renames, ratio→pixel snap). */
export function buildAtlasRequest(spec: WorkflowSpec): AtlasBuildResult {
  const p = spec.params;
  const imageUrls = urlArr(p, 'imageUrls').length
    ? urlArr(p, 'imageUrls')
    : spec.referenceAssets.filter((u) => !/\.(mp4|mov|webm)(\?|$)/i.test(u));
  const videoUrls = urlArr(p, 'videoUrls');
  const audioUrls = urlArr(p, 'audioUrls');
  const frameImages = workflowFrameImages(spec);

  if (spec.kind === 'video' && /gemini-omni-flash/i.test(spec.providerModelId)) {
    return buildGeminiOmniRequest(
      spec,
      frameImages.length > 0 ? frameImages.map((frame) => frame.url) : imageUrls,
    );
  }

  if (spec.kind === 'video') {
    // Family guard: this gateway only knows Seedance (+ Omni above). Without
    // this, an admin pointing `fallback_gateway='atlascloud'` at e.g. Veo would
    // silently submit it AS Seedance (`seedanceModelId` regex-infers the id)
    // and bill/deliver the wrong model with no error.
    if (!/seedance/i.test(`${spec.providerModelId} ${spec.modelId}`)) {
      throw new ProviderError({
        code: 'MODEL_UNAVAILABLE',
        status: 400,
        retryable: false,
        message: `atlascloud video route supports Seedance/Gemini-Omni only, got '${spec.providerModelId}'`,
      });
    }
    const { id, mode, fast } = seedanceModelId(
      spec,
      frameImages.length > 0 || imageUrls.length > 0,
    );
    const maxDur =
      spec.maxDurationSeconds && spec.maxDurationSeconds > 0 ? spec.maxDurationSeconds : 15;
    // duration_seconds === -1 → let the model pick (auto). Otherwise clamp to
    // [4, min(maxDur, 15)] — the same window the API bills for (units = bounded
    // duration), so duration sent == duration billed.
    const rawDur = asNum(p['duration_seconds'], 5);
    const duration = rawDur === -1 ? -1 : Math.max(4, Math.min(Math.round(rawDur), maxDur, 15));
    let resolution = asStr(p['resolution'], '720p');
    const allowedRes = fast ? SEEDANCE_FAST_RES : SEEDANCE_RES;
    if (!allowedRes.includes(resolution)) resolution = resolution === '1080p' ? '720p' : '720p';
    let ratio = asStr(p['aspect_ratio'], '16:9'); // our param key is aspect_ratio…
    if (!VIDEO_RATIOS.includes(ratio)) ratio = '16:9';

    const body: Record<string, unknown> = {
      model: id,
      prompt: spec.prompt,
      duration,
      resolution,
      ratio, // …AtlasCloud's wire field is `ratio`
      generate_audio: p['generate_audio'] !== false,
    };
    if (p['watermark'] === true) body['watermark'] = true;
    if (p['return_last_frame'] === true) body['return_last_frame'] = true;
    if (typeof p['seed'] === 'number') body['seed'] = p['seed'];

    if (mode === 'image-to-video') {
      const first = frameImages.find((frame) => frame.role === 'first')?.url ?? imageUrls[0];
      const last = frameImages.find((frame) => frame.role === 'last')?.url ?? imageUrls[1];
      if (first) body['image'] = first;
      if (last) body['last_image'] = last;
    } else if (mode === 'reference-to-video') {
      if (imageUrls.length) body['reference_images'] = imageUrls.slice(0, 9);
      if (videoUrls.length) body['reference_videos'] = videoUrls.slice(0, 3);
      if (audioUrls.length) body['reference_audios'] = audioUrls.slice(0, 3);
    }
    // text-to-video has no web_search equivalent on AtlasCloud — drop it.
    return { path: '/model/generateVideo', body };
  }

  // image / image-edit — Seedream-only route (`seedreamModelId` maps every
  // request onto seedream-v4.5 variants); reject other families loudly instead
  // of silently billing a Flux/Recraft job as Seedream.
  if (!/seedream/i.test(`${spec.providerModelId} ${spec.modelId}`)) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message: `atlascloud image route supports Seedream only, got '${spec.providerModelId}'`,
    });
  }
  const imageControls = workflowImageControls(spec);
  // '3K' exists only on kie's Seedream 5.0 Lite — AtlasCloud serves the
  // Seedream 4.x family (1K/2K/4K), so it can't arrive via a validated
  // request; fall back to the 2K default defensively.
  const atlasResolution = imageControls.resolution === '3K' ? undefined : imageControls.resolution;
  const hasRefs = imageUrls.length > 0;
  // `n` is what the API billed for; sequential.max_images MUST equal it so the
  // provider returns n assets (charge == delivery).
  const n = Math.max(1, Math.min(Math.round(asNum(p['n'], 1)), 14));
  const model = seedreamModelId(hasRefs, n);
  const body: Record<string, unknown> = {
    model,
    prompt: spec.prompt,
    size: imageSizeToPixels(
      imageControls.aspectRatio ?? asStr(p['size'], '1:1'),
      atlasResolution ?? '2K',
    ),
  };
  if (n > 1) body['max_images'] = n;
  if (hasRefs) body['images'] = imageUrls.slice(0, 14);
  if (typeof p['seed'] === 'number') body['seed'] = p['seed'];
  return { path: '/model/generateImage', body };
}

/**
 * AtlasCloud adapter. Both image and video are async: submit returns a
 * prediction id, then we poll /model/result/{id} until terminal. No inline
 * image result — the worker always calls awaitResult().
 */
export class AtlasCloudAdapter implements ProviderAdapter {
  constructor(private readonly client: AtlasCloudClient) {}

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind === 'voice') throw new Error(`unsupported kind: ${spec.kind}`);
    const { path, body } = buildAtlasRequest(spec);
    const pred = await this.client.submit(path, body);
    if (!pred.id) {
      throw new ProviderError({
        code: 'NO_TASK_ID',
        status: 200,
        retryable: true,
        message: `submit returned no prediction id (status=${pred.status})`,
      });
    }
    return { providerJobId: pred.id, gateway: 'atlascloud' };
  }

  async awaitResult(handle: GenerationHandle, _spec: WorkflowSpec): Promise<GenerationResult> {
    const started = Date.now();
    let attempt = 0;
    // Transient poll errors must NOT fail the whole job — tolerate a run of
    // consecutive errors and keep polling until the ceiling. Only a real
    // `failed` status or the ceiling ends the job.
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 6;
    while (Date.now() - started < POLL_CEILING_MS) {
      const wait = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]!;
      await new Promise((r) => setTimeout(r, wait));
      attempt += 1;

      let pred: Awaited<ReturnType<typeof this.client.getResult>>;
      try {
        pred = await this.client.getResult(handle.providerJobId);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new ProviderError({
            code: 'POLL_UNREACHABLE',
            status: 503,
            retryable: true,
            message: `prediction ${handle.providerJobId}: ${consecutiveErrors} consecutive poll errors; last: ${(err as Error).message}`,
          });
        }
        continue; // transient — keep polling
      }

      if (pred.status === 'completed') {
        const urls = (pred.outputs ?? []).filter(
          (u): u is string => typeof u === 'string' && u.length > 0,
        );
        if (urls.length === 0) {
          throw new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: false,
            message: 'prediction completed with no output url',
          });
        }
        // M-1: AtlasCloud reports per-output NSFW in `has_nsfw_contents`, aligned
        // to `outputs` order. We don't discard it (the old behaviour) — carry it
        // through so the worker can tag the asset. `urls` is filtered from
        // `outputs`, so index alignment holds as long as no earlier output was a
        // dropped empty string; guard the lookup defensively.
        const nsfwFlags = pred.has_nsfw_contents;
        const assets = await Promise.all(
          urls.map(async (url, i): Promise<GenerationAsset> => {
            const fetched = await this.client.fetchAsset(url);
            return {
              bytes: fetched.bytes,
              contentType: fetched.contentType,
              extension: extensionFromContentType(fetched.contentType),
              nsfw: Array.isArray(nsfwFlags) ? nsfwFlags[i] === true : false,
            };
          }),
        );
        return { assets };
      }

      if (pred.status === 'failed') {
        const msg =
          typeof pred.error === 'string'
            ? pred.error
            : (pred.error?.message ?? pred.msg ?? 'prediction failed without message');
        const code =
          typeof pred.error === 'object' && pred.error?.code ? pred.error.code : 'PROVIDER_FAILED';
        throw new ProviderError({ code, status: 200, retryable: false, message: msg });
      }
      // created | processing → keep polling
    }
    throw new ProviderError({
      code: 'TIMEOUT',
      status: 408,
      retryable: false,
      message: `prediction ${handle.providerJobId} did not finish within ${POLL_CEILING_MS}ms`,
    });
  }
}
