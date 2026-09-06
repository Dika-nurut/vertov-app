import { request, type Dispatcher } from 'undici';
import { egressDispatcher } from './egress';
import { guardedRequest } from './net-guard';
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
import { classifyProviderError, extensionFromContentType, urlArr } from './adapter-helpers';

/**
 * kie.ai gateway adapter — fallback for the Nano Banana family, used when
 * laozhang.ai (primary) fails. Async task-based API (unlike laozhang's sync
 * chat/generateContent): POST /createTask → taskId, poll /recordInfo until
 * `state` is 'success'/'fail'.
 *
 * Empirically verified live 2026-07-02 (real `nano-banana-pro` calls, not
 * just docs): 1K took 23s / 18 credits ($0.09 at the confirmed $0.005/credit
 * rate), 4K took 126s / 24 credits ($0.12) — matches the public price exactly,
 * but 4K is meaningfully slower than laozhang.ai's 38s. A fallback triggered
 * on a 4K job means a real 2+ minute wait, not a seamless swap.
 */

const POLL_CEILING_MS = 180_000;
const POLL_BACKOFF_MS = [3_000, 5_000, 8_000, 12_000, 20_000] as const;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;

/** Our catalog's providerModelId (no slash, matches laozhang's Gemini model
 * names) → kie.ai's marketplace model slug. */
const MODEL_SLUGS: Record<string, string> = {
  'gemini-3-pro-image': 'nano-banana-pro',
  'gemini-3-pro-image-preview': 'nano-banana-pro',
  'gemini-2.5-flash-image': 'google/nano-banana',
  'gemini-3.1-flash-image': 'nano-banana-2',
  'gemini-3.1-flash-lite-image': 'nano-banana-2-lite',
  // Seedream 4.5 — kie is the availability FALLBACK for the active `seedream-4-5`
  // catalog row (OpenRouter primary), replacing the dropped AtlasCloud leg: kie is
  // cheaper ($0.0325 vs $0.04/img, t2i+i2i). Slugs verified against kie's own docs
  // 2026-07-25 (docs.kie.ai/market/seedream/4-5-text-to-image, /4-5-edit). Keyed by
  // the row's providerModelId (the BytePlus form) — that is what the worker puts on
  // the spec. Edit/reference requests branch to the `seedream/4.5-edit` sibling
  // slug in buildKieImageBody.
  'doubao-seedream-4.5': 'seedream/4.5-text-to-image',
  // Seedream 5.0 Pro — verified 2026-07-16 against kie's own OpenAPI docs
  // (docs.kie.ai/market/seedream/5-pro-text-to-image). Reference edits use the
  // sibling `seedream/5-pro-image-to-image` slug, branched in
  // buildKieImageBody — kie splits t2i/i2i exactly like gpt-image-2.
  'seedream-5-0-pro': 'seedream/5-pro-text-to-image',
  // Seedream 5.0 Lite — same docs family (docs.kie.ai/market/seedream/5-lite-*),
  // verified 2026-07-24. i2i sibling slug branched in buildKieImageBody.
  'seedream-5-0-lite': 'seedream/5-lite-text-to-image',
  // Gemini Omni video: this slug lived hardcoded inside buildKieVideoBody until
  // 2026-07-16. It is listed here so the video path is slug-driven like images;
  // the resolved string is unchanged, and a test pins that.
  'gemini-omni-flash-text-to-video': 'gemini-omni-video',
  // HappyHorse 1.1 — the owner's "latest" mandate. Verified 2026-07-16 against
  // docs.kie.ai/38309290e0 ("HappyHorse 1.1 文生视频"). Deliberately the EXPLICIT
  // versioned slug: kie also publishes an unversioned `happyhorse/text-to-video`
  // whose docs never state which version it serves, so it could silently drift
  // across releases. This slug names its version, so there is nothing to infer.
  // Reference runs use the `happyhorse-1-1/image-to-video` sibling, branched in
  // buildKieVideoBody.
  'happyhorse-1-1-text-to-video': 'happyhorse-1-1/text-to-video',
  // Active HappyHorse 1.1 row's providerModelId is the OpenRouter slash-form
  // `alibaba/happyhorse-1.1` (OR is its cheaper PRIMARY: $0.099/s vs kie $0.113/s,
  // both paid-verified). This maps that row to kie's verified v1.1 slug so kie can
  // serve as an availability FALLBACK (docs/live-route-test-plan route 7b, CDN path
  // `happyhorse-v1_1/` confirms v1.1, NOT the bare `happyhorse/text-to-video` v1.0 alias).
  'alibaba/happyhorse-1.1': 'happyhorse-1-1/text-to-video',
  // Seedance 2.0 — kie serves the family (paid-verified: route #4 `bytedance/seedance-2-fast`
  // task 18d5d9a8; route #5 `bytedance/seedance-2` + reference_image_urls task c9dec662).
  // OpenRouter is the cheaper PRIMARY (kie is dearer, and fast has NO 1080p on kie); these
  // slugs exist so kie is wired as an availability FALLBACK on OR outage (owner 2026-07-20).
  'seedance-2.0-text-to-video': 'bytedance/seedance-2',
  'seedance-2-0-fast': 'bytedance/seedance-2-fast',
  'seedance-2.0-reference-to-video': 'bytedance/seedance-2',
  'seedance-2.0-fast-reference-to-video': 'bytedance/seedance-2-fast',
  // Grok Imagine video — kie marketplace slug, standard createTask/recordInfo
  // shape (same as gemini-omni). Verified against real paid generations
  // (docs/platform/model-catalog.md GROK route). Slugged here; the
  // 720p cap and numeric-duration schema live in buildGrokVideoBody.
  'x-ai/grok-imagine-video': 'grok-imagine/text-to-video',
  // Wan 2.7 text-to-video — kie marketplace slug, standard createTask/recordInfo
  // shape (same envelope as gemini-omni/grok). Verified against a real paid
  // generation (docs/platform/model-catalog.md:
  // `wan/2-7-text-to-video`, 720p 3s 16:9 → 1280x720 h264+aac; 1080p → 1920x1080).
  // Routed kie-primary because kie is cheaper than the OpenRouter leg it fronts
  // (720p $0.08/s vs ~$0.10/s; 1080p $0.12/s). The DB providerModelId is the
  // OpenRouter slash-form ('alibaba/wan-2.7'); this maps it to kie's slug.
  'alibaba/wan-2.7': 'wan/2-7-text-to-video',
  // Veo 3.1 family — kie does NOT serve these through createTask/recordInfo;
  // it uses a DEDICATED /api/v1/veo/* endpoint family (buildKieVeoBody +
  // KieClient.createVeoTask/veoRecordInfo). These slugs are the `model` value
  // that endpoint expects. NOTE the DB providerModelIds are slash-form; the
  // lookup maps those to kie's underscore veo3* slugs.
  'google/veo-3.1': 'veo3',
  'google/veo-3.1-fast': 'veo3_fast',
  'google/veo-3.1-lite': 'veo3_lite',
  // FLUX.2 Pro — kie is the cheaper PRIMARY ($0.025/img at 1K vs OpenRouter
  // $0.03), wired 2026-08-04. Slug verified against the captured spec
  // (docs/platform/vendor-api/kie-specs/flux2__pro-text-to-image.md): the DOC
  // path is `flux2/…` but the `model` value kie accepts is `flux-2/…` — they
  // differ, and model-catalog.md previously recorded neither correctly.
  // Reference edits branch to the `flux-2/pro-image-to-image` sibling in
  // buildKieImageBody, exactly like gpt-image-2 and seedream.
  'black-forest-labs/flux.2-pro': 'flux-2/pro-text-to-image',
};

/** Providers that route through kie's dedicated /api/v1/veo/* endpoints rather
 * than the shared createTask/recordInfo market path. Keyed by our DB
 * providerModelId (slash-form). */
const VEO_MODEL_IDS = new Set(['google/veo-3.1', 'google/veo-3.1-fast', 'google/veo-3.1-lite']);

export function isKieVeoModel(providerModelId: string): boolean {
  return VEO_MODEL_IDS.has(providerModelId);
}

export function kieModelSlug(providerModelId: string): string {
  const slug = MODEL_SLUGS[providerModelId];
  if (!slug) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message: `no kie.ai slug for model '${providerModelId}'`,
    });
  }
  return slug;
}

/** True if the leading bytes are a known image/video container signature. Content-type
 *  headers are unreliable (a CDN error page can arrive as octet-stream or with no type),
 *  so this magic-number sniff is the trustworthy check that the body is really media —
 *  an HTML/JSON error page matches nothing here and is rejected regardless of its label. */
function looksLikeMediaMagic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // Images
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true; // GIF87a/89a
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return true; // WEBP
  // Video
  if (buf.toString('ascii', 4, 8) === 'ftyp') return true; // MP4 / MOV (ISO BMFF)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // WebM / Matroska (EBML)
  return false;
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

const KIE_BATCH_PREFIX = 'kie-batch:';

function encodeTaskIds(ids: string[]): string {
  return ids.length === 1 ? ids[0]! : `${KIE_BATCH_PREFIX}${ids.map(encodeURIComponent).join(',')}`;
}

function decodeTaskIds(value: string): string[] {
  if (!value.startsWith(KIE_BATCH_PREFIX)) return [value];
  return value.slice(KIE_BATCH_PREFIX.length).split(',').filter(Boolean).map(decodeURIComponent);
}

export function buildKieImageBody(spec: WorkflowSpec): Record<string, unknown> {
  const imageUrls = urlArr(spec.params, 'imageUrls').length
    ? urlArr(spec.params, 'imageUrls')
    : spec.referenceAssets.filter((url) => !/\.(mp4|mov|webm)(\?|$)/i.test(url));
  const controls = workflowImageControls(spec);

  if (spec.providerModelId === 'gpt-image-2') {
    // quality: low/medium/high, the vendor's OWN values (owner ruling, phase 1.1) —
    // read directly off spec.params (not workflowImageControls, whose `resolution`
    // is typed to the 1K/2K/3K/4K pixel-tier union and would drop a quality word).
    // `resolution` is the primary key (matches /boards + priceSelectorFromParams'
    // preference order); `quality` stays a fallback for a stale/third-party caller
    // that still sends the legacy alias — either way, served == billed.
    const quality = spec.params['resolution'] ?? spec.params['quality'];
    return {
      model: imageUrls.length ? 'gpt-image-2-image-to-image' : 'gpt-image-2-text-to-image',
      input: {
        prompt: spec.prompt,
        ...(imageUrls.length ? { input_urls: imageUrls.slice(0, 8) } : {}),
        ...(controls.aspectRatio ? { aspect_ratio: controls.aspectRatio } : {}),
        ...(quality === 'low' || quality === 'medium' || quality === 'high' ? { quality } : {}),
      },
    };
  }

  // FLUX.2 Pro — verified schema (kie-specs/flux2__pro-{text,image}-to-image.md).
  // One constraint kie's card does not advertise and the price list did not carry:
  // `resolution` is REQUIRED and enumerates 1K | 2K, where kie bills $0.025 vs $0.035.
  // Our catalog row sells no size control (`resolutions: []`) and is priced off the
  // 1K rate, so we PIN 1K. Sending 2K would serve a tier we do not sell at a cost we
  // do not charge for (18.2% margin at 13 credits).
  //
  // `input_urls` — CORRECTED 2026-08-09. A prior version of this comment claimed it
  // was a single uri string and refused any request above one reference. That was
  // never read off the vendor: `kie-specs/flux2__pro-image-to-image.md` (captured
  // 2026-08-04, 14 minutes BEFORE the wrong comment was written in the same session)
  // declares `input_urls` a REQUIRED array, 1–8 images, with a worked two-image
  // example. No paid probe on record contradicts it (checked
  // `docs/platform/ai-api-probe-ledger.md`). We now send the spec's shape and trust
  // the vendor's own contract; `maxImages: 8` on the route registry matches maxItems.
  //
  // This is safe if the spec is wrong in the way that matters most: a clean
  // submit-time 4xx (JournaledAdapter records it, `isAmbiguousSubmitError` does
  // not match it — see types.ts) still falls over to the OpenRouter leg that can
  // serve it, no worse than the old client-side refusal. It is NOT provably safe
  // against kie accepting the array and then failing the task after a handle is
  // returned, or silently using only the first image — neither is a submit-time
  // rejection, so CircuitBreakerAdapter would not catch either. No paid
  // two-reference probe exists yet to rule those out; one settles it.
  if (spec.providerModelId === 'black-forest-labs/flux.2-pro') {
    return {
      model: imageUrls.length ? 'flux-2/pro-image-to-image' : 'flux-2/pro-text-to-image',
      input: {
        prompt: spec.prompt,
        ...(imageUrls.length ? { input_urls: imageUrls.slice(0, 8) } : {}),
        aspect_ratio: controls.aspectRatio ?? '1:1',
        // Was pinned to '1K' while 1K was the only rung we sold. rev. 14 re-bands the
        // cheap rung `default` → `1K` and activates the 2K row (measured $0,035, 15
        // credits), so the declared list is now ['1K','2K'] and the rung must come from
        // the request. Anything else — kie's enum stops at 2K, there is no 4K — falls
        // back to 1K, which is the rung a bare request is priced at.
        resolution: controls.resolution === '2K' ? '2K' : '1K',
      },
    };
  }

  // Seedream 4.5 — verified schema (docs.kie.ai/market/seedream/4-5-*) 2026-07-25:
  // reference/edit requests route to the sibling `seedream/4.5-edit` slug
  // (`image_urls` maxItems 14 — matches the catalog row's maxRefs), and `quality`
  // (basic=2K | high=4K) is the ONLY resolution lever — kie's 4.5 has no 1K tier
  // and no `resolution`/`output_format` field, so unlike the 5.x branches we send
  // neither. kie bills FLAT $0.0325/img at either quality, so a 1K/2K ask maps to
  // basic (a 1K ask delivers 2K — pure upgrade, no COGS skew at the flat price).
  if (spec.providerModelId === 'doubao-seedream-4.5') {
    return {
      model: imageUrls.length ? 'seedream/4.5-edit' : kieModelSlug(spec.providerModelId),
      input: {
        prompt: spec.prompt,
        ...(imageUrls.length ? { image_urls: imageUrls.slice(0, 14) } : {}),
        ...(controls.aspectRatio ? { aspect_ratio: controls.aspectRatio } : {}),
        quality: controls.resolution === '4K' ? 'high' : 'basic',
      },
    };
  }

  // Seedream 5.0 Pro — verified schema (docs.kie.ai/market/seedream/5-pro-*):
  // `image_urls` maxItems 10, and `quality` (basic=1K | high=2K) is the ONLY
  // resolution lever — the model has no `resolution` field and no 4K tier, so
  // it must not ride the nano-banana branch below.
  if (spec.providerModelId === 'seedream-5-0-pro') {
    return {
      model: imageUrls.length
        ? 'seedream/5-pro-image-to-image'
        : kieModelSlug(spec.providerModelId),
      input: {
        prompt: spec.prompt,
        ...(imageUrls.length ? { image_urls: imageUrls.slice(0, 10) } : {}),
        ...(controls.aspectRatio ? { aspect_ratio: controls.aspectRatio } : {}),
        quality: controls.resolution && controls.resolution !== '1K' ? 'high' : 'basic',
        output_format: 'png',
      },
    };
  }

  // Seedream 5.0 Lite — verified schema (docs.kie.ai/market/seedream/5-lite-*):
  // same envelope as 5-pro, but `quality` is basic=2K/high=3K/ultra=4K and kie
  // bills FLAT at any quality, so no resolution→price mapping is needed here —
  // the request just translates our resolution labels into kie's quality enum.
  if (spec.providerModelId === 'seedream-5-0-lite') {
    return {
      model: imageUrls.length
        ? 'seedream/5-lite-image-to-image'
        : kieModelSlug(spec.providerModelId),
      input: {
        prompt: spec.prompt,
        ...(imageUrls.length ? { image_urls: imageUrls.slice(0, 10) } : {}),
        ...(controls.aspectRatio ? { aspect_ratio: controls.aspectRatio } : {}),
        quality:
          controls.resolution === '4K' ? 'ultra' : controls.resolution === '3K' ? 'high' : 'basic',
        output_format: 'png',
      },
    };
  }

  const isBaseBanana = spec.providerModelId === 'gemini-2.5-flash-image';
  const isLite = spec.providerModelId === 'gemini-3.1-flash-lite-image';
  const model =
    isBaseBanana && imageUrls.length
      ? 'google/nano-banana-edit'
      : kieModelSlug(spec.providerModelId);
  const referenceField = isBaseBanana || isLite ? 'image_urls' : 'image_input';
  return {
    model,
    input: {
      prompt: spec.prompt,
      ...(imageUrls.length ? { [referenceField]: imageUrls.slice(0, isLite ? 10 : 8) } : {}),
      ...(controls.aspectRatio ? { aspect_ratio: controls.aspectRatio } : {}),
      ...(!isBaseBanana && !isLite && controls.resolution
        ? { resolution: controls.resolution }
        : {}),
      output_format: 'png',
    },
  };
}

/**
 * HappyHorse 1.1 (Alibaba) — verified 2026-07-16 against docs.kie.ai/38309290e0
 * (text-to-video) and docs.kie.ai/market/happyhorse-1-1/image-to-video.
 * Deliberately NOT the gemini-omni shape below; three schema differences that a
 * shared body would get wrong:
 *  - `duration` is a NUMBER (3..15, multipleOf 1) here, where gemini-omni takes
 *    a STRING.
 *  - image-to-video is a separate slug whose `image_urls` is the first-frame
 *    image, and it drops `aspect_ratio` (derived from the source image).
 *  - there is NO audio input field: the model emits audio+video jointly in one
 *    pass (fal.ai/models/alibaba/happy-horse/v1.1/text-to-video), so audio is
 *    model-managed output and must not be invented as a request param.
 */
function buildHappyHorseVideoBody(
  spec: WorkflowSpec,
  imageUrls: string[],
): Record<string, unknown> {
  const isImageToVideo = imageUrls.length > 0;
  const resolution = spec.params['resolution'];
  const aspectRatio = workflowImageControls(spec).aspectRatio;
  return {
    model: isImageToVideo ? 'happyhorse-1-1/image-to-video' : kieModelSlug(spec.providerModelId),
    input: {
      prompt: spec.prompt,
      // ceil (matches billing's Math.ceil), floored to the 4s min-billable (min of
      // capabilities.durations [4,6,8,10]) and capped at the ROW max — not kie's raw
      // 15s schema ceiling, else a 15s ask bills at maxDurationSeconds (10) but kie
      // delivers 15 (COGS leak); and a sub-4s ask must not deliver fewer than billed.
      duration: Math.min(
        spec.maxDurationSeconds ?? 15,
        Math.max(4, Math.ceil(asNum(spec.params['duration_seconds'], 5))),
      ),
      // Only 720p/1080p exist — drop anything else (e.g. our 480p option)
      // rather than send an off-enum value.
      ...(resolution === '720p' || resolution === '1080p' ? { resolution } : {}),
      ...(isImageToVideo
        ? { image_urls: imageUrls.slice(0, 1) }
        : aspectRatio
          ? { aspect_ratio: aspectRatio }
          : {}),
    },
  };
}

/** kie's `gemini-omni-video` only accepts ['16:9', '9:16'] (live 422 verified
 * 2026-07-17: "Aspect ratio only supports [16:9, 9:16]"). Any other ratio our
 * board/generate params carry (e.g. '1:1', '3:4') is mapped to the nearer of
 * the two rather than rejected. */
function omniAspectRatio(raw: string | undefined): '16:9' | '9:16' {
  if (raw === '16:9' || raw === '9:16') return raw;
  const match = raw?.match(/^(\d+):(\d+)$/);
  if (match) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return w < h ? '9:16' : '16:9';
    }
  }
  return '16:9';
}

/** Kie's video schemas, keyed by our provider model id. Gemini Omni's audio is
 * model-managed on that route and therefore must not be invented here — but
 * aspect_ratio and resolution ARE real accepted fields (unlike the stale claim
 * this comment used to make; live 422 on 2026-07-17 proved aspect_ratio is
 * actually REQUIRED). */
export function buildKieVideoBody(spec: WorkflowSpec): Record<string, unknown> {
  const frameImages = workflowFrameImages(spec);
  const referenceImageUrls = urlArr(spec.params, 'imageUrls').length
    ? urlArr(spec.params, 'imageUrls')
    : spec.referenceAssets.filter((url) => !/\.(mp4|mov|webm)(\?|$)/i.test(url));
  const imageUrls = frameImages.length ? frameImages.map((frame) => frame.url) : referenceImageUrls;

  if (
    spec.providerModelId === 'happyhorse-1-1-text-to-video' ||
    spec.providerModelId === 'alibaba/happyhorse-1.1'
  ) {
    return buildHappyHorseVideoBody(spec, imageUrls);
  }

  if (spec.providerModelId === 'x-ai/grok-imagine-video') {
    return buildGrokVideoBody(spec);
  }

  if (spec.providerModelId === 'alibaba/wan-2.7') {
    return buildWanVideoBody(spec);
  }

  if (SEEDANCE_KIE_IDS.has(spec.providerModelId)) {
    return buildSeedanceVideoBody(spec);
  }

  const resolution = spec.params['resolution'];
  // Gemini Omni has one plural generic image_urls channel, not positional frames.
  // Preserve legacy/pre-deploy frameImages jobs by placing those URLs first in
  // their declared order, then append any generic reference images.
  // UNVERIFIED-OURS (2026-07-29): kie documents "Multiple Files: Yes" without a
  // maximum; retain the existing 7-item wire cap until we have vendor evidence.
  const omniImageUrls =
    spec.providerModelId === 'gemini-omni-flash-text-to-video'
      ? [...new Set([...frameImages.map((frame) => frame.url), ...referenceImageUrls])]
      : imageUrls;
  if (spec.providerModelId === 'gemini-omni-flash-text-to-video' && omniImageUrls.length > 7) {
    throw new ProviderError({
      code: 'INVALID_REQUEST',
      status: 400,
      retryable: false,
      message: `gemini omni kie: received ${omniImageUrls.length} images, maximum is 7 — refusing to silently drop conditioning`,
    });
  }
  return {
    model: kieModelSlug(spec.providerModelId),
    input: {
      prompt: spec.prompt,
      duration: String(asNum(spec.params['duration_seconds'], 4)),
      aspect_ratio: omniAspectRatio(workflowImageControls(spec).aspectRatio),
      // 720p, always. kie does price this route flat per second regardless of
      // resolution (snapshot 2026-07-17), which is why this used to default to
      // 1080p as a free quality upgrade — a fair reading of cost, but the wrong
      // reading of the product. Owner ruling 2026-08-09: omni is a 720p product.
      // Two things break if the primary quietly serves 1080p: the AtlasCloud
      // reserve leg is a 720p-only route, so a failover would hand the same job
      // back at a different resolution; and nothing downstream — no price row,
      // no capability, no UI rung — describes a 1080p omni output. Cost is
      // unchanged either way; consistency is not.
      resolution: '720p',
      ...(omniImageUrls.length ? { image_urls: omniImageUrls } : {}),
    },
  };
}

/** The grok kie route is TEXT-TO-VIDEO only in our wiring; its body sends NO
 * conditioning input (first-frame/reference IMAGE, reference VIDEO, or reference
 * AUDIO). The grok catalog row advertises frames:[] so the UI won't offer them; this
 * reject is DEFENSE-IN-DEPTH for a crafted API request that carries a ref anyway.
 * Rejecting a conditioned job loudly beats silently rendering plain t2v — a wrong
 * deliverable. Covers every reference channel. (kie grok i2v exists; wire it + re-add
 * the frames capability before allowing refs on this route.) */
function assertKieVideoTextToVideoOnly(spec: WorkflowSpec, route: string): void {
  const hasReference =
    workflowFrameImages(spec).length > 0 ||
    urlArr(spec.params, 'imageUrls').length > 0 ||
    urlArr(spec.params, 'videoUrls').length > 0 ||
    urlArr(spec.params, 'audioUrls').length > 0 ||
    spec.referenceAssets.length > 0;
  if (hasReference) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message: `${route}: image/video/audio reference conditioning is not wired on the kie route (text-to-video only) — refusing to silently drop it and render plain t2v`,
    });
  }
}

/** veo on kie accepts text + optional FRAME IMAGES (first / first+last, via
 * generationType FIRST_AND_LAST_FRAMES_2_VIDEO). It has NO video- or audio-reference
 * channel, so a job carrying those must fail loudly (a crafted API POST — the UI
 * can't set them) rather than silently render without them. Frame images are the one
 * allowed conditioning input; they flow through veoFrameImageUrls. */
function assertKieVeoImageRefsOnly(spec: WorkflowSpec, route: string): void {
  // Frame images arrive via params.frameImages/imageUrls (veoFrameImageUrls). The
  // video/audio ref channels and the generic referenceAssets array are NOT forwarded
  // to veo/generate, so a job carrying them must fail loudly rather than silently
  // render without them.
  const hasNonImageRef =
    urlArr(spec.params, 'videoUrls').length > 0 ||
    urlArr(spec.params, 'audioUrls').length > 0 ||
    spec.referenceAssets.length > 0;
  if (hasNonImageRef) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message: `${route}: only text + frame images are supported (no video/audio references)`,
    });
  }
}

/** Ordered [first(, last)] frame-image URLs for veo's FIRST_AND_LAST_FRAMES_2_VIDEO
 * mode. kie takes 1 image (the frame the clip unfolds from) or 2 (first + last, a
 * transition). Roles other than first/last are ignored. Empty → text-to-video.
 *
 * REJECTS a last-only set: kie's positional one-image form treats the single image as
 * the FIRST/seed frame, so sending a lone 'last' would silently condition the START on
 * the intended ENDING — a wrong deliverable at the same charge. A last frame is only
 * meaningful paired with a first (the [first, last] transition). */
function veoFrameImageUrls(spec: WorkflowSpec, route: string): string[] {
  const byRole = new Map(workflowFrameImages(spec).map((frame) => [frame.role, frame.url]));
  const first = byRole.get('first');
  const last = byRole.get('last');
  if (last && !first) {
    throw new ProviderError({
      code: 'UNSUPPORTED_FRAMES',
      status: 400,
      retryable: false,
      message: `${route}: a last-frame-only job has no valid kie encoding (a single image is taken as the FIRST frame) — provide a first frame`,
    });
  }
  const urls: string[] = [];
  if (first) urls.push(first);
  if (last) urls.push(last);
  return urls;
}

/** Reject a duration above the model's hard maximum. The charge path bills the
 * REQUESTED seconds, so clamping down would deliver fewer seconds than charged;
 * refuse instead (the UI constrains this; only a crafted API POST reaches here). */
function assertKieVideoDuration(seconds: number, maxSeconds: number, route: string): void {
  if (seconds > maxSeconds) {
    throw new ProviderError({
      code: 'UNSUPPORTED_DURATION',
      status: 400,
      retryable: false,
      message: `${route}: requested ${seconds}s exceeds the model maximum ${maxSeconds}s`,
    });
  }
}

/**
 * Grok Imagine text-to-video — verified against real paid generations
 * (docs/platform/model-catalog.md GROK route). Same createTask/
 * recordInfo envelope as gemini-omni, but its own body schema:
 *  - `duration` is a NUMBER of seconds (the reference run used 6), NOT the
 *    stringified value gemini-omni sends.
 *  - 720p is the hard ceiling: `resolution:"1080p"` returned a live 422, so we
 *    only ever emit '480p' or '720p' and map any higher request down to 720p.
 *    (Safe: there is no grok 1080p price-point row, so no charge/deliver gap.)
 *  - `aspect_ratio` is effectively required (grok 422'd without it); grok
 *    accepts the same {16:9, 9:16} pair as gemini-omni, so omniAspectRatio's
 *    nearest-of-two mapping is exactly right here too.
 */
function buildGrokVideoBody(spec: WorkflowSpec): Record<string, unknown> {
  assertKieVideoTextToVideoOnly(spec, 'grok-imagine kie');
  const resolution = spec.params['resolution'];
  // ceil (matching billing's Math.ceil and the registry duration contract) so we never
  // DELIVER fewer seconds than the charge path bills, floored to grok's 6s vendor
  // minimum. Above-max is still rejected (billing rejects it too — consistent).
  const duration = Math.max(6, Math.ceil(asNum(spec.params['duration_seconds'], 6)));
  assertKieVideoDuration(duration, 6, 'grok-imagine kie'); // maxDurationSeconds: 6
  return {
    model: kieModelSlug(spec.providerModelId),
    input: {
      prompt: spec.prompt,
      // Whole seconds; the reference clip was 6s (grok's only documented length).
      duration,
      // 720p cap — forward 480p as-is, everything else (incl. 1080p) → 720p.
      resolution: resolution === '480p' ? '480p' : '720p',
      aspect_ratio: omniAspectRatio(workflowImageControls(spec).aspectRatio),
    },
  };
}

/** Wan advertises {16:9, 9:16, 1:1} (models.ts). Pass a declared ratio through
 * UNCHANGED so we never silently deliver a different shape than asked — mapping 1:1
 * down to 16:9 (as the 2-value omniAspectRatio would) is a wrong deliverable, and it
 * breaks the square-product presets. An off-enum crafted value the UI can't produce
 * defaults to 16:9. If kie rejects 1:1 the submit 422s and the OpenRouter fallback
 * (which also does 1:1) delivers it — either way the shape is honored, never faked. */
const WAN_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);
function wanAspectRatio(spec: WorkflowSpec): string {
  const requested = workflowImageControls(spec).aspectRatio;
  return typeof requested === 'string' && WAN_ASPECT_RATIOS.has(requested) ? requested : '16:9';
}

/**
 * Wan 2.7 IMAGE-to-video on kie — its own endpoint and its own slug.
 *
 * Frame-conditioned Wan jobs used to be refused here and served by the OpenRouter
 * reserve instead, because this slug had never been wired. That refusal was honest (it
 * beat silently rendering plain t2v) but it cost real money: the kie leg is the cheaper
 * one on both rungs, and every keyframed Wan job was paying the OpenRouter rate.
 *
 * Read off `kie-specs/wan__2-7-image-to-video.md`, which differs from the t2v sibling in
 * three ways that matter and would each be a silent defect if copied across:
 *
 *   - the frames are NAMED fields, `first_frame_url` / `last_frame_url`, not an array;
 *   - there is NO aspect field at all — the frame decides the shape, so sending one
 *     would be an unknown key the vendor drops (the t2v route's `ratio`, itself the only
 *     one of 54 kie specs with that name, does not apply here);
 *   - `duration` is an INTEGER, where t2v takes a string.
 *
 * A LAST-frame-only job is deliberately still refused: the endpoint names the field, but
 * we have never seen it serve one, and the OpenRouter reserve wires first/last
 * explicitly. Failing here hands that job to the leg we know does it, which is the whole
 * point of having a reserve — it does not lose the capability.
 *
 * UNVERIFIED BY A PAID CALL. The schema is captured, the rates are the owner's own kie
 * card (2026-08-02), but nothing has run through this slug yet. A definitive submit-time
 * 4xx falls over to OpenRouter via CircuitBreakerAdapter; an accepted-then-failed task
 * would not. One paid keyframe call settles it.
 */
function buildWanImageToVideoBody(
  spec: WorkflowSpec,
  frames: readonly { role: 'first' | 'last'; url: string }[],
): Record<string, unknown> {
  const byRole = new Map(frames.map((frame) => [frame.role, frame.url]));
  const first = byRole.get('first');
  const last = byRole.get('last');
  if (!first) {
    throw new ProviderError({
      code: 'UNSUPPORTED_FRAMES',
      status: 400,
      retryable: false,
      message:
        'wan-2.7 kie i2v: a last-frame-only job has not been verified on this route — ' +
        'refusing so the OpenRouter reserve, which wires first/last explicitly, serves it',
    });
  }
  // NOT a check on `imageUrls`: for a frames-capable model those ARE the keyframes —
  // `workflowFrameImages` reads them (or `referenceAssets`) into the two slots, which is
  // how the Board sends a keyframe today. Refusing them here would have rejected the very
  // jobs this route exists to serve. What must still fail is a channel we cannot express:
  // the endpoint's `first_clip_url` / `driving_audio_url` are not products we sell.
  if (urlArr(spec.params, 'videoUrls').length > 0 || urlArr(spec.params, 'audioUrls').length > 0) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message:
        'wan-2.7 kie i2v: video/audio reference conditioning is not wired on this route — ' +
        'refusing to silently drop it',
    });
  }
  // A third image has nowhere to go: the endpoint has exactly two frame fields and
  // `workflowFrameImages` silently truncates to the declared slots. Charging for an
  // image the render never sees is the same defect class as a dropped aspect ratio.
  const offered = urlArr(spec.params, 'imageUrls').length || spec.referenceAssets.length;
  if (offered > frames.length) {
    throw new ProviderError({
      code: 'UNSUPPORTED_FRAMES',
      status: 400,
      retryable: false,
      message:
        `wan-2.7 kie i2v: ${offered} images offered but this route has ${frames.length} frame ` +
        'slot(s) — refusing to drop the rest silently',
    });
  }
  // Same billing window as t2v: floor to the 4s MIN BILLABLE duration rather than the
  // schema's lower 2s, else a crafted sub-4s ask is billed 4s and delivered shorter.
  const duration = Math.max(4, Math.ceil(asNum(spec.params['duration_seconds'], 5)));
  assertKieVideoDuration(duration, 10, 'wan-2.7 kie i2v'); // maxDurationSeconds: 10
  const resolution = spec.params['resolution'];
  return {
    model: 'wan/2-7-image-to-video',
    input: {
      prompt: spec.prompt,
      first_frame_url: first,
      ...(last ? { last_frame_url: last } : {}),
      duration,
      resolution: resolution === '720p' ? '720p' : '1080p',
    },
  };
}

/**
 * Wan 2.7 text-to-video on kie — same createTask/recordInfo envelope as
 * gemini-omni/grok. Verified against a real paid generation
 * (docs/platform/model-catalog.md: `wan/2-7-text-to-video`,
 * 720p 3s 16:9 → 1280x720 h264+aac; 1080p → 1920x1080). Routed kie-PRIMARY with
 * OpenRouter FALLBACK (owner directive 2026-07-20) because kie is cheaper than the
 * OpenRouter leg it fronts (720p $0.08/s vs ~$0.10/s; 1080p $0.12/s).
 *
 * TEXT-TO-VIDEO ONLY on this route: Wan first/last-frame conditioning is served by
 * separate kie i2v slugs we have NOT verified, so a frame-bearing job is rejected at
 * SUBMIT and the fallback chain re-runs it on OpenRouter (which DOES wire
 * frame_images) — see CircuitBreakerAdapter.generate(). NOTE the fallback covers
 * SUBMIT-time failures (this guard, a kie submit outage); a kie failure AFTER submit
 * (during poll) refunds the job rather than falling back (awaitResult polls the
 * primary only). The catalog keeps frames:['first','last'] because the capability
 * exists product-wide — it's just served by the fallback leg, not this one.
 */
function buildWanVideoBody(spec: WorkflowSpec): Record<string, unknown> {
  const frames = workflowFrameImages(spec);
  if (frames.length > 0) return buildWanImageToVideoBody(spec, frames);
  assertKieVideoTextToVideoOnly(spec, 'wan-2.7 kie');
  // Floor to the model's MIN BILLABLE duration (4s = smallest of capabilities.durations
  // [4,6,8,10], the same value minBillableDurationSeconds bills), NOT kie's lower 3s
  // schema minimum — else a crafted sub-4s ask is billed 4s but delivered 3s. kie accepts
  // arbitrary 4–10s, so mid-values (5/7/9) deliver exactly what ceil(requested) bills.
  const duration = Math.max(4, Math.ceil(asNum(spec.params['duration_seconds'], 5)));
  assertKieVideoDuration(duration, 10, 'wan-2.7 kie'); // maxDurationSeconds: 10
  const resolution = spec.params['resolution'];
  return {
    model: kieModelSlug(spec.providerModelId),
    input: {
      prompt: spec.prompt,
      duration: String(duration),
      // `ratio`, NOT `aspect_ratio`. This endpoint is the ONLY one of the 54 captured
      // kie specs that names the field this way (`wan__2-7-text-to-video.md`, where it
      // is REQUIRED); every other kie route really does take `aspect_ratio`, which is
      // how the wrong name got here. kie ignores the unknown key and falls back to its
      // own default of 16:9 — so the paid verification run (720p 16:9 → 1280x720) could
      // not see the bug, because 16:9 is exactly the value a dropped field produces.
      // A customer picking 9:16 or 1:1 was charged for the shape they asked for and
      // handed a landscape video.
      ratio: wanAspectRatio(spec),
      resolution: resolution === '720p' ? '720p' : '1080p',
    },
  };
}

/** The four Seedance 2.0 rows kie can serve (OpenRouter stays PRIMARY; kie is the
 * availability fallback). Keys are the rows' providerModelIds. */
const SEEDANCE_KIE_IDS = new Set([
  'seedance-2.0-text-to-video',
  'seedance-2-0-fast',
  'seedance-2.0-reference-to-video',
  'seedance-2.0-fast-reference-to-video',
]);

/**
 * Seedance 2.0 on kie — AVAILABILITY FALLBACK only (OpenRouter is the cheaper
 * primary; kie is dearer and its `fast` slug has no 1080p). Verified paid runs
 * (docs/platform/model-catalog.md): `bytedance/seedance-2-fast`
 * t2v (task 18d5d9a8), route #5 `bytedance/seedance-2` + `reference_image_urls`
 * (task c9dec662). The documented body input keys include image, video, and audio
 * references. The catalogue row decides what imageUrls mean: rows advertising
 * `frames` use them positionally, while `reference: true` rows use them as generic
 * references. kie has no Seedance frame parameter, so frame rows fail closed.
 */
function buildSeedanceVideoBody(spec: WorkflowSpec): Record<string, unknown> {
  const isFast = /fast/i.test(spec.providerModelId);
  const explicitFrames = spec.params['frameImages'];
  const imageUrls = urlArr(spec.params, 'imageUrls');
  const videoUrls = urlArr(spec.params, 'videoUrls');
  const audioUrls = urlArr(spec.params, 'audioUrls');
  const hasConditioning =
    (Array.isArray(explicitFrames) && explicitFrames.length > 0) ||
    imageUrls.length > 0 ||
    videoUrls.length > 0 ||
    audioUrls.length > 0 ||
    spec.referenceAssets.length > 0;
  const advertisedFrames = spec.capabilities?.['frames'];
  const isFrameRow =
    Array.isArray(advertisedFrames) &&
    advertisedFrames.some((role) => role === 'first' || role === 'last');
  const isReferenceRow = spec.capabilities?.['reference'] === true;

  if (isFrameRow && hasConditioning) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message:
        'seedance kie: this catalogue row advertises positional frames, but kie has no Seedance frame parameter — refusing to reinterpret or drop conditioning',
    });
  }
  if (hasConditioning && !isReferenceRow) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message:
        'seedance kie: the catalogue row does not advertise reference conditioning — refusing to guess how to serialize it',
    });
  }
  if (Array.isArray(explicitFrames) && explicitFrames.length > 0) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message:
        'seedance kie: image/video/audio references are supported, but explicit first/last frames are not — attach the image as a reference instead',
    });
  }
  const maxDur = spec.maxDurationSeconds ?? 15;
  // ceil to match billing's Math.ceil(duration), floored to the 4s min-billable
  // (min of capabilities.durations [4,…]) and capped at the row max — never deliver
  // fewer seconds than the charge path bills.
  const duration = Math.min(
    maxDur,
    Math.max(4, Math.ceil(asNum(spec.params['duration_seconds'], 5))),
  );
  // fast has NO 1080p on kie (live 422); std serves 480p/720p/1080p. Anything else → 720p.
  const requested = asStr(spec.params['resolution'], '720p');
  const allowed = isFast ? ['480p', '720p'] : ['480p', '720p', '1080p'];
  const resolution = allowed.includes(requested) ? requested : '720p';
  const input: Record<string, unknown> = {
    prompt: spec.prompt,
    duration,
    resolution,
    aspect_ratio: asStr(spec.params['aspect_ratio'], '16:9'),
  };
  const imageRefs = [...new Set([...imageUrls, ...spec.referenceAssets])];
  if (imageRefs.length > 9 || videoUrls.length > 3 || audioUrls.length > 3) {
    throw new ProviderError({
      code: 'INVALID_REQUEST',
      status: 400,
      retryable: false,
      message: `seedance kie: reference limits are 9 images, 3 videos, and 3 audios; received ${imageRefs.length}/${videoUrls.length}/${audioUrls.length} — refusing to silently truncate conditioning`,
    });
  }
  if (imageRefs.length) input['reference_image_urls'] = imageRefs;
  if (videoUrls.length) input['reference_video_urls'] = videoUrls;
  if (audioUrls.length) input['reference_audio_urls'] = audioUrls;
  return { model: kieModelSlug(spec.providerModelId), input };
}

/**
 * Veo 3.1 (Quality / Fast / Lite) submit body for kie's DEDICATED endpoint
 * `POST /api/v1/veo/generate` — verified against real paid generations
 * (docs/platform/model-catalog.md). This is NOT
 * the createTask/recordInfo market shape: there is no `input` wrapper, and the field
 * names follow kie's published schema — camelCase `generationType`/`imageUrls` but
 * snake_case `aspect_ratio` (NOT camelCase `aspectRatio`, which kie silently ignores).
 *
 * Resolution: the `resolution` enum (720p|1080p) is honored INLINE on generate — a
 * live run 2026-07-19 submitted resolution:1080p and the base task returned a genuine
 * 1920x1080 file (720p returns 1280x720). The separate GET /veo/get-1080p-video
 * endpoint is ONLY for upgrading a task that was generated at 720p; on a
 * 1080p-generated task it 422s ("already a 1080p video"), so we never call it. 4K
 * would need the POST /veo/get-4k-video two-step AND a 4K price row — neither exists —
 * so it is rejected rather than delivered at a lower resolution.
 *
 * Frames: with one or two frame images this submits FIRST_AND_LAST_FRAMES_2_VIDEO
 * (image-to-video / transition); with none, TEXT_2_VIDEO.
 */
export function buildKieVeoBody(spec: WorkflowSpec): Record<string, unknown> {
  assertKieVeoImageRefsOnly(spec, 'veo kie');
  const resolution = spec.params['resolution'];
  // 4K is neither priced nor wired (it needs POST /veo/get-4k-video), so refuse it
  // rather than deliver 1080p/720p at a 4K charge — the silent downgrade the resolver
  // forbids. 720p and 1080p are both delivered inline (see the resolution note above).
  if (resolution === '4k' || resolution === '4K') {
    throw new ProviderError({
      code: 'UNSUPPORTED_RESOLUTION',
      status: 400,
      retryable: false,
      message: `veo kie: 4K needs the /veo/get-4k-video two-step (not wired) and has no price row`,
    });
  }
  // ceil (matching billing's Math.ceil and the registry duration contract) so we never
  // DELIVER fewer seconds than the charge path bills — a fractional request like 4.2s
  // serializes 5 (as billed), not the 4 that Math.round produced (the closed veo
  // billed>served skew). Floored to veo's 4s vendor minimum; above-max (8s) rejected.
  const duration = Math.max(4, Math.ceil(asNum(spec.params['duration_seconds'], 8)));
  assertKieVideoDuration(duration, 8, 'veo kie'); // maxDurationSeconds: 8
  const imageUrls = veoFrameImageUrls(spec, 'veo kie');
  return {
    model: kieModelSlug(spec.providerModelId),
    prompt: spec.prompt,
    generationType: imageUrls.length > 0 ? 'FIRST_AND_LAST_FRAMES_2_VIDEO' : 'TEXT_2_VIDEO',
    // Honored inline: resolution:1080p → the base task returns 1920x1080 (live-verified
    // 2026-07-19). Anything but 1080p renders at 720p.
    resolution: resolution === '1080p' ? '1080p' : '720p',
    // Veo clips are discrete integer seconds; standard/only length is 8s.
    duration,
    aspect_ratio: omniAspectRatio(workflowImageControls(spec).aspectRatio),
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
  };
}

interface CreateTaskResponse {
  code: number;
  /** kie.ai's real field name is `msg`, not `message` — verified live 2026-07-02. */
  msg?: string;
  data?: { taskId?: string };
}

interface RecordInfoResponse {
  code: number;
  msg?: string;
  data?: {
    taskId: string;
    state: 'waiting' | 'generating' | 'success' | 'fail' | string;
    resultJson?: string;
    failCode?: string | number;
    failMsg?: string;
    /** Kie invoices each task; older responses omitted this field. */
    creditsConsumed?: number;
  };
}

/** kie's dedicated Veo endpoints share the `{code,msg,data}` envelope but a
 * different data shape from createTask/recordInfo. */
interface VeoGenerateResponse {
  code: number;
  msg?: string;
  data?: { taskId?: string };
}

interface VeoRecordInfoResponse {
  code: number;
  msg?: string;
  data?: {
    taskId?: string;
    /** 1 = done. 0/absent = still generating; other numbers = failed. */
    successFlag?: number;
    response?: {
      resultUrls?: string[];
      hasAudioList?: unknown;
    };
    errorCode?: string | number;
    errorMessage?: string;
    /** Kie invoices each Veo task too. */
    creditsConsumed?: number;
  };
}

export interface KieClientOptions {
  baseUrl?: string;
  apiKey: string;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
}

export class KieClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly submitTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  // undefined unless EGRESS_PROXY_URL is set → identical to today's direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: KieClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.kie.ai').replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.submitTimeoutMs = opts.submitTimeoutMs ?? 30_000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 20_000;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };
  }

  private async json<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await request(url, {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw classifyProviderError(
        0,
        'NETWORK',
        `${method} ${path} network error: ${(err as Error).message}`,
      );
    }
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw classifyProviderError(res.statusCode, `HTTP_${res.statusCode}`, text.slice(0, 500));
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ProviderError({
        code: 'PARSE_ERROR',
        status: 200,
        retryable: true,
        message: `${method} ${path}: non-JSON response: ${(err as Error).message}; head=${text.slice(0, 160)}`,
      });
    }
  }

  createTask(body: unknown): Promise<CreateTaskResponse> {
    return this.json('POST', '/api/v1/jobs/createTask', body, this.submitTimeoutMs);
  }

  recordInfo(taskId: string): Promise<RecordInfoResponse> {
    return this.json(
      'GET',
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      undefined,
      this.pollTimeoutMs,
    );
  }

  /** Veo submit — dedicated endpoint, not the shared createTask path. */
  createVeoTask(body: unknown): Promise<VeoGenerateResponse> {
    return this.json('POST', '/api/v1/veo/generate', body, this.submitTimeoutMs);
  }

  /** Veo poll — sibling of createVeoTask under the same /api/v1/veo prefix. */
  veoRecordInfo(taskId: string): Promise<VeoRecordInfoResponse> {
    return this.json(
      'GET',
      `/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`,
      undefined,
      this.pollTimeoutMs,
    );
  }

  async fetchAsset(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    let res;
    try {
      res = await guardedRequest(url, {
        method: 'GET',
        signal: AbortSignal.timeout(60_000),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw classifyProviderError(
        0,
        'NETWORK',
        `fetchAsset network error: ${(err as Error).message}`,
      );
    }
    if (res.statusCode >= 400) {
      throw classifyProviderError(res.statusCode, `HTTP_${res.statusCode}`, 'fetchAsset failed');
    }
    const contentType =
      (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
    const buf = Buffer.from(await res.body.arrayBuffer());
    // A provider/CDN glitch can answer 200 with an error page or an empty body instead
    // of the asset. Committing the charge for those bytes = the prohibited "customer
    // paid, wrong/fabricated asset" outcome, so a non-media or empty response is a failed
    // generation (retryable → terminal refund), not a successful asset. Trust the BYTES,
    // NOT the content-type header — a header is forgeable/mislabeled (an error page can
    // arrive as video/mp4), so require a real media magic-number for EVERY response. kie's
    // outputs are mp4 (video) + png/jpg (image), all covered by looksLikeMediaMagic.
    if (buf.byteLength === 0) {
      throw new ProviderError({
        code: 'EMPTY_ASSET',
        status: 200,
        retryable: true,
        message: `provider returned an empty body for ${url.slice(0, 120)}`,
      });
    }
    if (!looksLikeMediaMagic(buf)) {
      throw new ProviderError({
        code: 'NON_MEDIA_ASSET',
        status: 200,
        retryable: true,
        message: `provider response has no media signature (content-type '${contentType}', ${buf.byteLength}B) — likely an error page, not an asset`,
      });
    }
    if (buf.byteLength > MAX_ASSET_BYTES) {
      throw new ProviderError({
        code: 'ASSET_TOO_LARGE',
        status: 413,
        retryable: false,
        message: `asset bytes ${buf.byteLength} exceeds ${MAX_ASSET_BYTES}`,
      });
    }
    return { bytes: buf, contentType };
  }
}

/**
 * Kie's account unit is a credit, not a dollar. This rate is the finance-owned
 * conversion recorded in docs/platform/cost-model-schema-v2-2026-08-02.md and
 * docs/platform/vendor-api/kie-pricing-video.md ($0.005 per Kie credit). It is
 * not inferred from a catalogue row or from the customer's credit price.
 */
export const KIE_CREDIT_USD_RATE = 0.005;
export const KIE_CREDIT_USD_RATE_SOURCE =
  'docs/platform/cost-model-schema-v2-2026-08-02.md; docs/platform/vendor-api/kie-pricing-video.md';

function kieInvoiceMeta(
  values: readonly (number | undefined)[],
): Record<string, unknown> | undefined {
  if (values.length === 0 || values.every((value) => value === undefined)) return undefined;
  const complete = values.every(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
  if (!complete) {
    return {
      providerCostComplete: false,
      providerCostSource: 'kie.creditsConsumed',
    };
  }
  const credits = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    providerCostKieCredits: credits,
    providerCostUsd: credits * KIE_CREDIT_USD_RATE,
    providerCostComplete: true,
    providerCostSource: 'kie.creditsConsumed',
    providerCostRateUsdPerCredit: KIE_CREDIT_USD_RATE,
    providerCostRateSource: KIE_CREDIT_USD_RATE_SOURCE,
  };
}

export class KieAdapter implements ProviderAdapter {
  private readonly pollBackoffMs: readonly number[];

  constructor(
    private readonly client: KieClient,
    opts: { pollBackoffMs?: readonly number[] } = {},
  ) {
    this.pollBackoffMs = opts.pollBackoffMs ?? POLL_BACKOFF_MS;
  }

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind === 'video') return this.generateVideo(spec);
    if (spec.kind !== 'image' && spec.kind !== 'image-edit') {
      throw new Error(`kie.ai adapter only supports image and video kinds, got: ${spec.kind}`);
    }
    const count = Math.min(workflowImageControls(spec).count, 4);
    const responses = await Promise.all(
      Array.from({ length: count }, () => this.client.createTask(buildKieImageBody(spec))),
    );
    const taskIds = responses.map((res) => {
      const taskId = res.data?.taskId;
      if (!taskId) {
        throw new ProviderError({
          code: 'NO_TASK_ID',
          status: res.code >= 400 ? res.code : 200,
          retryable: res.code >= 500,
          message: res.msg ?? 'kie.ai createTask returned no taskId',
        });
      }
      return taskId;
    });
    return { providerJobId: encodeTaskIds(taskIds), gateway: 'kie' };
  }

  /** Gemini Omni Flash — real endpoint confirmed live 2026-07-02
   * (`docs.kie.ai/market/gemini-omni-video`), but our own account balance was
   * too low to complete a real paid test (402 insufficient credits) — the
   * price in the model catalog comes from the owner's account pricing
   * dashboard, not a billed invoice. Same createTask/recordInfo shape as
   * images; `duration` is a STRING per the docs schema, not a number. */
  private async generateVideo(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (isKieVeoModel(spec.providerModelId)) return this.generateVeo(spec);
    const res = await this.client.createTask(buildKieVideoBody(spec));
    const taskId = res.data?.taskId;
    if (!taskId) {
      throw new ProviderError({
        code: 'NO_TASK_ID',
        status: res.code >= 400 ? res.code : 200,
        retryable: res.code >= 500,
        message: res.msg ?? 'kie.ai createTask returned no taskId',
      });
    }
    return { providerJobId: taskId, gateway: 'kie' };
  }

  /** Veo 3.1 — kie's dedicated /veo/generate submit, polled via /veo/record-info
   * (see awaitVeoTask). Distinct from the createTask/recordInfo market path. */
  private async generateVeo(spec: WorkflowSpec): Promise<GenerationHandle> {
    const res = await this.client.createVeoTask(buildKieVeoBody(spec));
    const taskId = res.data?.taskId;
    if (!taskId) {
      throw new ProviderError({
        code: 'NO_TASK_ID',
        status: res.code >= 400 ? res.code : 200,
        retryable: res.code >= 500,
        message: res.msg ?? 'kie.ai /veo/generate returned no taskId',
      });
    }
    return { providerJobId: taskId, gateway: 'kie' };
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    if (handle.inlineResult) return handle.inlineResult;

    // Veo resolves through its own poll endpoint (different response shape), so
    // it must not fall into the createTask/recordInfo batch path below. 600s
    // ceiling for parity with openrouter-adapter.ts video (a slow veo Quality job
    // must not hit a non-retryable timeout → refunded failure on the margin route).
    if (spec.kind === 'video' && isKieVeoModel(spec.providerModelId)) {
      const task = await this.awaitVeoTask(handle.providerJobId, 600_000);
      const meta = kieInvoiceMeta([task.creditsConsumed]);
      return { assets: task.assets, ...(meta ? { meta } : {}) };
    }

    // Video generation runs longer than image (Gemini Omni Flash) — same
    // ceiling class as our other video adapters (openrouter-adapter.ts uses
    // 600s), not the 180s image ceiling below.
    //
    // This was 300s, which contradicted the comment above AND our own catalogue:
    // `seedance-2-0-reference-to-video` declares expectedLatencyMsP95 = 420_000
    // (packages/db/seed/models.ts), so we stopped waiting a full two minutes
    // before the model's own 95th percentile. A real production job died exactly
    // there on 2026-07-29 (kie task 4c55ff85…, refunded on TIMEOUT) while the
    // task was still `waiting` at the vendor — we paid for it and threw it away.
    // 600s matches the OpenRouter adapter, clears P95 with headroom, and stays
    // under the worker reaper's 900s running-job timeout so the reaper, not this
    // poll, remains the outer bound.
    const ceilingMs = spec.kind === 'video' ? 600_000 : POLL_CEILING_MS;
    const taskIds = decodeTaskIds(handle.providerJobId);
    const results = await Promise.all(taskIds.map((taskId) => this.awaitTask(taskId, ceilingMs)));
    if (spec.kind === 'image' || spec.kind === 'image-edit') {
      const assets = results.map((task, index) => {
        const asset = task.assets[0];
        if (!asset) {
          throw new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: true,
            message: `kie.ai image task ${index + 1}/${results.length} returned no image`,
          });
        }
        return asset;
      });
      const meta = kieInvoiceMeta(results.map((task) => task.creditsConsumed));
      return { assets, ...(meta ? { meta } : {}) };
    }
    const meta = kieInvoiceMeta(results.map((task) => task.creditsConsumed));
    return {
      assets: results.flatMap((task) => task.assets),
      ...(meta ? { meta } : {}),
    };
  }

  private async awaitTask(
    taskId: string,
    ceilingMs: number,
  ): Promise<{ assets: GenerationAsset[]; creditsConsumed?: number }> {
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < ceilingMs) {
      const wait = this.pollBackoffMs[Math.min(attempt, this.pollBackoffMs.length - 1)]!;
      await new Promise((r) => setTimeout(r, wait));
      attempt += 1;

      const res = await this.client.recordInfo(taskId);
      const state = res.data?.state;

      if (state === 'success') {
        const resultUrls: string[] = res.data?.resultJson
          ? ((JSON.parse(res.data.resultJson) as { resultUrls?: string[] }).resultUrls ?? [])
          : [];
        if (resultUrls.length === 0) {
          throw new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: true,
            message: `kie.ai task ${taskId} succeeded with no result URLs`,
          });
        }
        const assets = await Promise.all(
          resultUrls.map(async (url): Promise<GenerationAsset> => {
            const fetched = await this.client.fetchAsset(url);
            return {
              bytes: fetched.bytes,
              contentType: fetched.contentType,
              extension: extensionFromContentType(fetched.contentType),
            };
          }),
        );
        return {
          assets,
          ...(res.data?.creditsConsumed === undefined
            ? {}
            : { creditsConsumed: res.data.creditsConsumed }),
        };
      }

      if (state === 'fail') {
        throw new ProviderError({
          code: String(res.data?.failCode ?? 'PROVIDER_FAILED'),
          status: 200,
          retryable: false,
          message: res.data?.failMsg ?? 'kie.ai task failed without message',
        });
      }
      // waiting | generating → keep polling
    }
    throw new ProviderError({
      code: 'TIMEOUT',
      status: 408,
      retryable: false,
      message: `kie.ai task ${taskId} did not finish within ${ceilingMs}ms`,
    });
  }

  /** Poll kie's dedicated /veo/record-info. Unlike recordInfo (string `state` +
   * JSON-encoded resultJson), veo reports a numeric `successFlag` (1 = done) and
   * hands the URLs back already-parsed at `data.response.resultUrls`. */
  private async awaitVeoTask(
    taskId: string,
    ceilingMs: number,
  ): Promise<{ assets: GenerationAsset[]; creditsConsumed?: number }> {
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < ceilingMs) {
      const wait = this.pollBackoffMs[Math.min(attempt, this.pollBackoffMs.length - 1)]!;
      await new Promise((r) => setTimeout(r, wait));
      attempt += 1;

      const res = await this.client.veoRecordInfo(taskId);
      const flag = res.data?.successFlag;

      if (flag === 1) {
        // The base task already returns the requested resolution inline (720p or 1080p —
        // buildKieVeoBody sets it on generate), so the base resultUrls ARE the deliverable.
        const resultUrls = res.data?.response?.resultUrls ?? [];
        if (resultUrls.length === 0) {
          throw new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: true,
            message: `kie.ai veo task ${taskId} succeeded with no result URLs`,
          });
        }
        const assets = await Promise.all(
          resultUrls.map(async (url): Promise<GenerationAsset> => {
            const fetched = await this.client.fetchAsset(url);
            return {
              bytes: fetched.bytes,
              contentType: fetched.contentType,
              extension: extensionFromContentType(fetched.contentType),
            };
          }),
        );
        return {
          assets,
          ...(res.data?.creditsConsumed === undefined
            ? {}
            : { creditsConsumed: res.data.creditsConsumed }),
        };
      }

      // successFlag other than 0/1 (kie uses 2/3 for failure) is terminal.
      if (typeof flag === 'number' && flag >= 2) {
        throw new ProviderError({
          code: String(res.data?.errorCode ?? 'PROVIDER_FAILED'),
          status: 200,
          retryable: false,
          message: res.data?.errorMessage ?? 'kie.ai veo task failed without message',
        });
      }
      // 0 | undefined → still generating, keep polling
    }
    throw new ProviderError({
      code: 'TIMEOUT',
      status: 408,
      retryable: false,
      message: `kie.ai veo task ${taskId} did not finish within ${ceilingMs}ms`,
    });
  }
}
