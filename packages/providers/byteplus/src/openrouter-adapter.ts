import { request, type Dispatcher } from 'undici';
import { byteplusRouteContracts, normalizeVideoParams } from '@seed/shared';
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
import { classifyProviderError, urlArr } from './adapter-helpers';

/**
 * OpenRouter gateway adapter — runs the same ByteDance models (Seedance 2.0
 * video, Seedream 4.5 image) through openrouter.ai.
 *
 * Video is async REST: POST /videos → { id, polling_url }, poll until
 * completed, download `unsigned_urls` WITH our Bearer key (they are
 * OpenRouter content endpoints, not presigned CDN links — the opposite of
 * Evolink's TOS URLs).
 *
 * Image is sync via OpenRouter's dedicated POST /images API. It accepts the
 * normalized resolution/aspect/count/reference contract and returns base64
 * assets inline, so awaitResult() does not poll.
 *
 * OpenRouter has no `return_last_frame` — the worker extracts the last frame
 * locally with ffmpeg (uniform across gateways), so the flag is ignored here.
 */

const POLL_CEILING_MS = 600_000; // Seedance 2.0 at 15s/1080p can run long
const POLL_BACKOFF_MS = [5_000, 8_000, 12_000, 20_000, 30_000] as const;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
/** Hard ceiling on the fan-out: `generate()` issues one paid call per image, so
 *  this is also the most units any single request can be billed for — which is
 *  what the official leg reserves against its budget. Exported so that
 *  reservation cannot drift from the number of calls actually made. */
export const MAX_IMAGE_BATCH = 4;

/** Our catalog's provider model ids (Evolink-style, with optional
 * -text/-image/-reference-to-video suffix) → OpenRouter slugs. */
const VIDEO_SLUGS: Record<string, string> = {
  'seedance-2.0': 'bytedance/seedance-2.0',
  'seedance-2-0': 'bytedance/seedance-2.0',
  'seedance-2-0-standard': 'bytedance/seedance-2.0',
  'seedance-2.0-fast': 'bytedance/seedance-2.0-fast',
  'seedance-2-0-fast': 'bytedance/seedance-2.0-fast',
  'seedance-1-5-pro': 'bytedance/seedance-1-5-pro',
  'seedance-1.5-pro': 'bytedance/seedance-1-5-pro',
};

export function openRouterVideoSlug(providerModelId: string): string {
  // De-hardcoded (S1): OpenRouter slugs are 'vendor/model' and are stored
  // verbatim on the model row's providerModelId (e.g. 'google/veo-3.1-fast').
  // Use them as-is. The VIDEO_SLUGS table only survives to translate our
  // legacy Evolink-style Seedance ids (no slash) for the byteplus catalog.
  if (providerModelId.includes('/')) return providerModelId;
  const base = providerModelId.replace(/-(text|image|reference)-to-video$/i, '');
  const slug = VIDEO_SLUGS[base];
  if (!slug) {
    throw new ProviderError({
      code: 'MODEL_UNAVAILABLE',
      status: 400,
      retryable: false,
      message: `no OpenRouter slug for video model '${providerModelId}'`,
    });
  }
  return slug;
}

export function openRouterImageSlug(providerModelId: string): string {
  // De-hardcoded (S2): a slug-shaped id is the OpenRouter slug verbatim
  // (e.g. 'black-forest-labs/flux.2-pro', 'google/gemini-2.5-flash-image').
  if (providerModelId.includes('/')) return providerModelId;
  if (/seedream|seededit/i.test(providerModelId)) return 'bytedance-seed/seedream-4.5';
  throw new ProviderError({
    code: 'MODEL_UNAVAILABLE',
    status: 400,
    retryable: false,
    message: `no OpenRouter slug for image model '${providerModelId}'`,
  });
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
}
function numList(v: unknown): number[] {
  return Array.isArray(v)
    ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    : [];
}

const OR_RESOLUTIONS = ['480p', '720p', '1080p'];
const OR_ASPECTS = ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'];

/** Snap a requested duration to the largest supported value not exceeding it,
 * falling back to the smallest supported when the request is below the floor. */
function snapDuration(requested: number, supported: number[]): number {
  const sorted = [...supported].sort((a, b) => a - b);
  const atOrBelow = sorted.filter((d) => d <= requested);
  return atOrBelow.length ? atOrBelow[atOrBelow.length - 1]! : sorted[0]!;
}

function imageEntry(url: string): { type: 'image_url'; image_url: { url: string } } {
  return { type: 'image_url', image_url: { url } };
}

/**
 * Does this model's OpenRouter image route have any output-size control? A route that
 * declares none must not be sent a rung. The answer is READ from the route contract
 * (`resolution: EMPTY_MENU` in `model-contract-byteplus.ts`) rather than kept as a
 * second list here, so a model added to one is never missing from the other.
 *
 * flux-2-pro is the case that forced it. kie is its charged primary and OpenRouter its
 * reserve; on 2026-08-10 it gained a 2K rung priced at 15 credits off kie's MEASURED
 * $0,035. OpenRouter bills FLUX per MEGAPIXEL at $0,03, and 2K is 1536² = 2,36 MP — so if
 * OpenRouter honoured a forwarded `resolution: '2K'` the reserve leg would cost 7,12 ₽
 * against 4,97 ₽ of revenue: **−43% margin on every failed-over 2K job**, under R-1's 0%
 * fallback floor rather than merely thin. Nobody has measured whether OpenRouter honours
 * the field or ignores it, and R-2 forbids assuming: not sending it is the only branch
 * that is safe under both answers.
 *
 * The cost of not sending it is that a 2K job that fails over comes back at the vendor's
 * ~1 MP default — a smaller picture at the 2K price, at 36% margin. That is a real
 * customer-facing shortfall and it is the LESSER failure: R-1 exists because refusing to
 * fail over turns a vendor outage into ours. Recorded as an open exposure, and it closes
 * when finance's requested paid OpenRouter 2K call lands and the rung can be either
 * priced or refused on evidence.
 */
export function openRouterImageRouteHasSizeControl(modelId: string): boolean {
  const routes = (byteplusRouteContracts[modelId] ?? []).filter(
    (route) => route.gateway === 'openrouter' && route.inputMode === 'image',
  );
  // No contract at all is not evidence of no size control — keep sending the rung, which
  // is what every uncontracted model did before this existed.
  if (routes.length === 0) return true;
  // An undeclared menu is unknown, not empty — treat it as having control, so only an
  // explicit `EMPTY_MENU` silences the rung.
  return routes.some((route) => (route.resolution?.values.length ?? 1) > 0);
}

/** Build one dedicated OpenRouter image request. The adapter fans out n as
 * one-output calls because some active endpoints only accept n=1. */
export function buildOpenRouterImageBody(spec: WorkflowSpec, count = 1): Record<string, unknown> {
  const controls = workflowImageControls(spec);
  const sizeless = !openRouterImageRouteHasSizeControl(spec.modelId);
  const imageUrls = urlArr(spec.params, 'imageUrls').length
    ? urlArr(spec.params, 'imageUrls')
    : spec.referenceAssets.filter((url) => !/\.(mp4|mov|webm)(\?|$)/i.test(url));
  return {
    model: openRouterImageSlug(spec.providerModelId),
    prompt: spec.prompt,
    n: count,
    ...(controls.resolution && !sizeless ? { resolution: controls.resolution } : {}),
    ...(controls.aspectRatio ? { aspect_ratio: controls.aspectRatio } : {}),
    ...(imageUrls.length > 0
      ? {
          input_references: imageUrls
            .slice(
              0,
              referenceCaps(spec.modelId, 'image', { images: 14, videos: 0, audios: 0 }).images,
            )
            .map(imageEntry),
        }
      : {}),
    ...(typeof spec.params['seed'] === 'number' ? { seed: spec.params['seed'] } : {}),
  };
}
/**
 * The reference caps this route really has, from the registry — not a literal.
 *
 * The caps were hardcoded (14 images on every image model, 9/3/3 on every reference
 * video model) while the contract already carried the true per-model numbers, sourced
 * from the vendor's own captured schema. `recraft-v4` is the live proof: its contract
 * and OpenRouter's `recraft__recraft-v4.json` both cap `input_references` at ONE, and
 * the adapter would forward fourteen. The video 9/3/3 is right today only because
 * Seedance is the sole model reaching that branch — Grok's own doc says 7.
 *
 * This may only TIGHTEN. A declared zero means the contract row we found is not
 * describing the call we are making — the reference branch keys off `providerModelId`
 * while contracts are keyed by catalogue `modelId`, and those two disagree for the
 * Seedance twins, where the reference variant is its own catalogue row. Treating that
 * zero as a cap would silently strip every reference off a reference job. So a zero
 * falls back to the literal, and an uncontracted model keeps today's behaviour
 * byte-for-byte.
 */
function referenceCaps(
  modelId: string,
  inputMode: 'image' | 'video',
  fallback: { images: number; videos: number; audios: number },
): { images: number; videos: number; audios: number } {
  const reference = byteplusRouteContracts[modelId]?.find(
    (candidate) => candidate.gateway === 'openrouter' && candidate.inputMode === inputMode,
  )?.reference;
  if (!reference) return fallback;
  const tighten = (declared: number, legacy: number): number =>
    declared > 0 ? Math.min(declared, legacy) : legacy;
  return {
    images: tighten(reference.maxImages, fallback.images),
    videos: tighten(reference.maxVideos, fallback.videos),
    audios: tighten(reference.maxAudios, fallback.audios),
  };
}

function videoEntry(url: string): { type: 'video_url'; video_url: { url: string } } {
  return { type: 'video_url', video_url: { url } };
}
function audioEntry(url: string): { type: 'audio_url'; audio_url: { url: string } } {
  return { type: 'audio_url', audio_url: { url } };
}

/** Build the POST /videos body. Mirrors the Evolink serializer semantics:
 * frames upgrade t2v to i2v, reference models take input_references,
 * 'adaptive' ratio is omitted so the model infers it from the frame. */
export function buildOpenRouterVideoBody(spec: WorkflowSpec): Record<string, unknown> {
  const p = spec.params;
  // Capability-driven (S4 wire side): each engine declares its own option space.
  // Absent/empty → the Seedance defaults, so existing rows are unchanged.
  const caps = (spec.capabilities ?? {}) as Record<string, unknown>;
  const allowedRes = strList(caps['resolutions']).length
    ? strList(caps['resolutions'])
    : OR_RESOLUTIONS;
  const allowedAspect = strList(caps['aspect_ratios']).length
    ? strList(caps['aspect_ratios'])
    : OR_ASPECTS;
  const allowedDurations = numList(caps['durations']);
  // `frames` lists the i2v anchor slots ['first','last']; an explicit empty
  // array means t2v-only (e.g. Sora) — no frame_images. Absent → legacy
  // Seedance behavior (first+last allowed).
  const audioSupported = caps['audio'] !== false;

  const imageUrls = urlArr(p, 'imageUrls').length
    ? urlArr(p, 'imageUrls')
    : spec.referenceAssets.filter((u) => !/\.(mp4|mov|webm)(\?|$)/i.test(u));
  // Differentiated reference attachments — the single drop zone files each by
  // type into these buckets so the provider knows what each one is.
  const videoUrls = urlArr(p, 'videoUrls');
  const audioUrls = urlArr(p, 'audioUrls');
  const frameImages = workflowFrameImages(spec);

  const maxDur = spec.maxDurationSeconds ?? 15;
  const rawDur = asNum(p['duration_seconds'], 5);

  // SR variants are an Evolink upsell — OpenRouter has plain tiers only.
  // Default to 720p when the model offers it (the universal safe tier), else
  // the model's lowest declared tier.
  const defaultRes = allowedRes.includes('720p') ? '720p' : (allowedRes[0] ?? '720p');
  let resolution = asStr(p['resolution'], defaultRes).replace(/-SR$/i, '');
  if (!allowedRes.includes(resolution)) {
    if (resolution === '1440p' || resolution === '2160p') resolution = '1080p';
    if (!allowedRes.includes(resolution)) {
      resolution = allowedRes.includes('720p') ? '720p' : (allowedRes[0] ?? '720p');
    }
  }

  const aspect = asStr(p['aspect_ratio'], '16:9');

  const body: Record<string, unknown> = {
    model: openRouterVideoSlug(spec.providerModelId),
    prompt: spec.prompt,
    resolution,
  };
  if (audioSupported) body['generate_audio'] = p['generate_audio'] !== false;
  if (rawDur !== -1) {
    body['duration'] = allowedDurations.length
      ? snapDuration(Math.round(rawDur), allowedDurations)
      : Math.max(4, Math.min(Math.round(rawDur), maxDur));
  }
  if (allowedAspect.includes(aspect)) body['aspect_ratio'] = aspect;
  if (typeof p['seed'] === 'number') body['seed'] = p['seed'];

  // Registry derivation (Phase 2): for a model with an OpenRouter route contract,
  // the accepted scalar param surface (resolution / aspect / duration / audio) is the
  // REGISTRY's authority — not the mutable catalog bag read above. Override those
  // fields from the contract's normalizer (the SAME `normalizeVideoParams` the billing
  // selector derives from, so the serialized selector matches the priced one once
  // pricing is switched over). Frames / references / seed stay the adapter's
  // structural concern, and uncovered models keep the legacy capability-driven values
  // byte-for-byte. For menu-shaped inputs the registry values equal the legacy ones
  // (parity guard); the difference is only the deliberate charge==deliver correction
  // on off-menu/crafted inputs.
  const orContract = byteplusRouteContracts[spec.modelId]?.find(
    (c) => c.gateway === 'openrouter' && c.inputMode === 'video',
  );
  if (orContract) {
    const norm = normalizeVideoParams(orContract, p);
    if (norm.ok) {
      if (norm.value.resolution !== undefined) body['resolution'] = norm.value.resolution;
      // Preserve the legacy -1 "let the model decide duration" sentinel (omit it).
      if (rawDur === -1) {
        delete body['duration'];
      } else if (norm.value.duration !== undefined) {
        body['duration'] = norm.value.duration;
      }
      if (norm.value.aspectRatio !== undefined) body['aspect_ratio'] = norm.value.aspectRatio;
      else delete body['aspect_ratio'];
      if (norm.value.generateAudio !== undefined) body['generate_audio'] = norm.value.generateAudio;
      else delete body['generate_audio'];
    }
  }

  const isReference = /reference-to-video/i.test(spec.providerModelId);
  if (isReference) {
    // input_references is a typed discriminated union (image_url | video_url |
    // audio_url) — OpenRouter's own multimodal-reference schema. Video/audio are
    // honored only by providers that support them (BytePlus Seedance 2.0);
    // others use the images and ignore the rest. Caps: 9 images, 3 video, 3 audio.
    const caps = referenceCaps(spec.modelId, 'video', { images: 9, videos: 3, audios: 3 });
    const refs = [
      ...imageUrls.slice(0, caps.images).map(imageEntry),
      ...videoUrls.slice(0, caps.videos).map(videoEntry),
      ...audioUrls.slice(0, caps.audios).map(audioEntry),
    ];
    if (refs.length) body['input_references'] = refs;
  } else if (frameImages.length > 0) {
    const frames = frameImages.map((frame) => ({
      ...imageEntry(frame.url),
      frame_type: frame.role === 'first' ? 'first_frame' : 'last_frame',
    }));
    body['frame_images'] = frames;
  }
  return body;
}

interface OpenRouterVideoJob {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
  unsigned_urls?: string[];
  error?: { code?: string | number; message?: string } | string;
  usage?: { cost?: number };
}

interface OpenRouterImageResponse {
  data?: { b64_json?: string; media_type?: string }[];
  usage?: { cost?: number };
}

function extensionFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('mp4')) return 'mp4';
  if (ct.includes('webm')) return 'webm';
  return 'bin';
}

export interface OpenRouterClientOptions {
  baseUrl: string;
  apiKey: string;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
  /** Image gen is sync — the request stays open while Seedream renders. */
  imageTimeoutMs?: number;
}

export class OpenRouterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly submitTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly imageTimeoutMs: number;
  // undefined unless EGRESS_PROXY_URL is set → identical to today's direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: OpenRouterClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    // S0-verified (2026-06-12): /videos holds the connection while the upstream
    // fetches + moderates input_references (observed 92 s on a slow ref) — a
    // 30 s submit timeout aborts mid-validation, so video submits get 180 s.
    this.submitTimeoutMs = opts.submitTimeoutMs ?? 180_000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
    this.imageTimeoutMs = opts.imageTimeoutMs ?? 120_000;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-title': 'Seed',
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

  submitVideo(body: unknown): Promise<OpenRouterVideoJob> {
    return this.json<OpenRouterVideoJob>('POST', '/videos', body, this.submitTimeoutMs);
  }

  getVideo(id: string): Promise<OpenRouterVideoJob> {
    return this.json<OpenRouterVideoJob>(
      'GET',
      `/videos/${encodeURIComponent(id)}`,
      undefined,
      this.pollTimeoutMs,
    );
  }

  generateImage(body: unknown): Promise<OpenRouterImageResponse> {
    return this.json('POST', '/images', body, this.imageTimeoutMs);
  }

  /** Download a result asset. OpenRouter content URLs are API endpoints —
   * they need our Bearer key (unlike Evolink's presigned TOS links). */
  async fetchAsset(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    let res;
    try {
      res = await guardedRequest(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(180_000),
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

function base64ImageToAsset(value: string, declaredType?: string): GenerationAsset {
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  const contentType = dataUrl?.[1] ?? declaredType ?? 'image/png';
  const base64 = dataUrl?.[2] ?? value;
  if (!base64) {
    throw new ProviderError({
      code: 'BAD_IMAGE_PAYLOAD',
      status: 200,
      retryable: false,
      message: 'image result contains no base64 payload',
    });
  }
  return {
    bytes: Buffer.from(base64, 'base64'),
    contentType,
    extension: extensionFromContentType(contentType),
  };
}

export class OpenRouterAdapter implements ProviderAdapter {
  private readonly pollBackoffMs: readonly number[];

  constructor(
    private readonly client: OpenRouterClient,
    opts: { pollBackoffMs?: readonly number[] } = {},
  ) {
    this.pollBackoffMs = opts.pollBackoffMs ?? POLL_BACKOFF_MS;
  }

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind === 'voice') throw new Error(`unsupported kind: ${spec.kind}`);

    if (spec.kind === 'video') {
      const job = await this.client.submitVideo(buildOpenRouterVideoBody(spec));
      if (!job.id) {
        // S0-verified (2026-06-12): /videos can reply 202 with keep-alive
        // padding and an EMBEDDED error object (e.g. upstream 400 when an
        // input_reference fails fetch or moderation). Surface that message
        // instead of a generic retryable NO_TASK_ID.
        if (job.error) {
          const msg =
            typeof job.error === 'string'
              ? job.error
              : (job.error.message ?? 'submit failed without message');
          const codeNum = typeof job.error === 'object' ? Number(job.error.code) : NaN;
          throw new ProviderError({
            code: 'SUBMIT_REJECTED',
            status: Number.isFinite(codeNum) ? codeNum : 200,
            retryable: Number.isFinite(codeNum) ? codeNum >= 500 : false,
            message: msg,
          });
        }
        throw new ProviderError({
          code: 'NO_TASK_ID',
          status: 200,
          retryable: true,
          message: `submit returned no job id (status=${job.status})`,
        });
      }
      return { providerJobId: job.id, gateway: 'openrouter' };
    }

    // Every call asks for exactly one output. This makes billed count equal
    // delivered count even for Flux/Gemini endpoints whose native n max is 1.
    const n = Math.min(workflowImageControls(spec).count, MAX_IMAGE_BATCH);
    const calls = await Promise.all(
      Array.from({ length: n }, () => this.client.generateImage(buildOpenRouterImageBody(spec, 1))),
    );
    const assets: GenerationAsset[] = [];
    for (const [index, res] of calls.entries()) {
      const image = (res.data ?? []).find(
        (candidate): candidate is { b64_json: string; media_type?: string } =>
          typeof candidate.b64_json === 'string' && candidate.b64_json.length > 0,
      );
      if (!image) {
        throw new ProviderError({
          code: 'NO_ASSET',
          status: 200,
          retryable: true,
          message: `OpenRouter image call ${index + 1}/${n} returned no image`,
        });
      }
      assets.push(base64ImageToAsset(image.b64_json, image.media_type));
    }
    // `usage.cost` is the only invoice we ever get, and the official leg's loss
    // budget REPLACES a whole reservation with it. Summing a missing cost as 0
    // made a 1-of-4 subtotal indistinguishable from a complete bill, so a
    // four-image job settled at one image's price — and then booked the revenue
    // of all four, which can read as profit and free the cap. The sum stays
    // visible for diagnosis; `providerCostComplete` is what says it may be spent
    // as a bill, and a consumer must require it to be `true`.
    const costed = calls.filter((response) => typeof response.usage?.cost === 'number');
    const providerCostUsd = costed.reduce((total, response) => total + response.usage!.cost!, 0);
    return {
      providerJobId: `or-img-${Date.now().toString(36)}`,
      gateway: 'openrouter',
      inlineResult: {
        assets,
        ...(providerCostUsd > 0
          ? { meta: { providerCostUsd, providerCostComplete: costed.length === n } }
          : {}),
      },
    };
  }

  async awaitResult(handle: GenerationHandle, _spec: WorkflowSpec): Promise<GenerationResult> {
    if (handle.inlineResult) return handle.inlineResult;

    const started = Date.now();
    let attempt = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 6;
    while (Date.now() - started < POLL_CEILING_MS) {
      const wait = this.pollBackoffMs[Math.min(attempt, this.pollBackoffMs.length - 1)]!;
      await new Promise((r) => setTimeout(r, wait));
      attempt += 1;

      let job: OpenRouterVideoJob;
      try {
        job = await this.client.getVideo(handle.providerJobId);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new ProviderError({
            code: 'POLL_UNREACHABLE',
            status: 503,
            retryable: true,
            message: `video ${handle.providerJobId}: ${consecutiveErrors} consecutive poll errors; last: ${(err as Error).message}`,
          });
        }
        continue;
      }

      if (job.status === 'completed') {
        const urls = (job.unsigned_urls ?? []).filter(
          (u): u is string => typeof u === 'string' && u.length > 0,
        );
        if (urls.length === 0) {
          throw new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: false,
            message: 'video completed with no result url',
          });
        }
        const assets = await Promise.all(
          urls.map(async (url): Promise<GenerationAsset> => {
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
          // One job, one bill: a video's usage.cost is complete by construction.
          ...(job.usage?.cost !== undefined
            ? { meta: { providerCostUsd: job.usage.cost, providerCostComplete: true } }
            : {}),
        };
      }

      if (job.status === 'failed') {
        const msg =
          typeof job.error === 'string'
            ? job.error
            : (job.error?.message ?? 'video failed without message');
        const code =
          typeof job.error === 'object' && job.error?.code
            ? String(job.error.code)
            : 'PROVIDER_FAILED';
        throw new ProviderError({ code, status: 200, retryable: false, message: msg });
      }
      // pending | in_progress → keep polling
    }
    throw new ProviderError({
      code: 'TIMEOUT',
      status: 408,
      retryable: false,
      message: `video ${handle.providerJobId} did not finish within ${POLL_CEILING_MS}ms`,
    });
  }
}
