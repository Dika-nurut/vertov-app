import { randomUUID } from 'node:crypto';
import { request, type Dispatcher } from 'undici';
import { egressDispatcher } from './egress';
import { guardedRequest } from './net-guard';
import {
  ProviderError,
  workflowImageControls,
  type GenerationAsset,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';
import { classifyProviderError, urlArr } from './adapter-helpers';

/**
 * laozhang.ai gateway adapter — the Nano Banana family (Gemini image models),
 * called directly instead of through OpenRouter's markup on top of Google's
 * own price (verified 2026-07-02: OpenRouter charged $0.241344 for a 4K
 * gemini-3-pro-image generation; laozhang.ai's own dashboard/pricing API
 * lists the same model at a flat $0.09/generation — ~63% cheaper).
 *
 * Image-only, sync (like OpenRouter's image path): the result is attached to
 * the handle as an inlineResult, no polling.
 *
 * Gemini jobs use the native
 * `/v1beta/models/{model}:generateContent` route for every resolution so Board
 * aspect/resolution controls and inline reference images keep one exact shape.
 * GPT Image 2 remains on the separate OpenAI-compatible Images API route, whose
 * current primary contract does not expose Board size controls or references.
 */

const IMAGE_TIMEOUT_MS = 120_000;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_IMAGE_BATCH = 4;
const MAX_REFERENCE_IMAGES = 8;
// Per-reference cap for the /v1/images/edits multipart path — far below the generic
// 500 MB asset ceiling so a request with 8 refs fanned across n batches cannot balloon
// the aggregate multipart body into GBs of worker memory (a real image ref is a few MB).
const MAX_EDIT_REFERENCE_BYTES = 20 * 1024 * 1024;

function extensionFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  return 'bin';
}

function oneAssetPerCall(results: GenerationAsset[][], provider: string): GenerationAsset[] {
  return results.map((assets, index) => {
    const asset = assets[0];
    if (!asset) {
      throw new ProviderError({
        code: 'NO_ASSET',
        status: 200,
        retryable: true,
        message: `${provider} image call ${index + 1}/${results.length} returned no image`,
      });
    }
    return asset;
  });
}

/** Legacy explicit pixel sizes → the Gemini imageConfig tier. */
function resolutionTier(p: Record<string, unknown>): '2K' | '4K' | null {
  const raw = p['resolution'] ?? p['size'];
  if (typeof raw !== 'string') return null;
  const upper = raw.toUpperCase();
  if (upper === '4K' || upper === '2K') return upper;
  const wh = /^(\d+)x(\d+)$/.exec(raw);
  if (!wh) return null;
  const maxSide = Math.max(Number(wh[1]), Number(wh[2]));
  if (maxSide >= 3000) return '4K';
  if (maxSide >= 1536) return '2K';
  return null;
}

// GPT Image 2 accepts arbitrary WxH when both edges are divisible by 16, the
// largest edge is <=3840, pixels are 655,360..8,294,400, and the ratio is 1:3..3:1.
// These are the deliberately offered Board formats; they all sit well within the
// vendor bounds and keep the primary and fallback aspect menus aligned.
const GPT_IMAGE_2_SIZE_BY_ASPECT: Record<string, string> = {
  '21:9': '1792x768',
  '16:9': '1536x864',
  '3:2': '1536x1024',
  '4:3': '1536x1152',
  '1:1': '1024x1024',
  '3:4': '1152x1536',
  '2:3': '1024x1536',
  '9:16': '864x1536',
};

/** Build the exact JSON body sent to laozhang for a single image request.
 *
 * Kept pure so catalog/pricing conformance tests can inspect the provider-facing
 * quality tier without making a network call. `referenceParts` are fetched by the
 * adapter and supplied only for Gemini-native image requests.
 */
export function buildLaozhangImageBody(
  spec: WorkflowSpec,
  referenceParts: unknown[] = [],
): Record<string, unknown> {
  if (spec.providerModelId === 'gpt-image-2') {
    const rawQuality = spec.params['resolution'] ?? spec.params['quality'];
    const quality =
      rawQuality === 'low' || rawQuality === 'medium' || rawQuality === 'high'
        ? rawQuality
        : undefined;
    const aspect = spec.params['aspect_ratio'];
    const size = typeof aspect === 'string' ? GPT_IMAGE_2_SIZE_BY_ASPECT[aspect] : undefined;
    return {
      // NOT `spec.providerModelId`. laozhang's own docs, twice: "Default-group
      // `gpt-image-2` still does not support `size` / `quality`" and, under that
      // route, "`quality`: not supported. Do not pass `size` or `quality`."
      // We were sending the default-group name WITH both fields, so on this leg —
      // which is the PRIMARY for gpt-image-2 (`forceGateway: 'nanobanana'` =
      // laozhang → kie) — the tier was silently dropped and every request returned
      // the same default image. We bill 13 / 21 / 33 credits for low / medium /
      // high, so "high" was 2.5x the price of "low" for identical output.
      // `-vip` is the documented route that accepts both, at the SAME $0.03/call.
      //
      // CAUTION, and the reason this needs a paid re-check rather than trust:
      // laozhang's changelog shows `-vip` size support lost 2026-06-16, restored
      // 06-18, lost again 06-23, restored 07-09 WITH quality. The capability is
      // unstable at this vendor, so treat a passing doc as a hypothesis. The kie
      // fallback leg honours the tier unconditionally and is unaffected.
      model: 'gpt-image-2-vip',
      prompt: spec.prompt,
      ...(quality ? { quality } : {}),
      ...(size ? { size } : {}),
    };
  }

  const controls = workflowImageControls(spec);
  const rawTier = controls.resolution ?? resolutionTier(spec.params) ?? undefined;
  // '3K' exists only on kie's Seedream 5.0 Lite — no laozhang-served model
  // declares it, so it can't arrive via a validated request; drop it
  // defensively rather than invent a downscale mapping.
  const imageSize = rawTier === '3K' ? undefined : rawTier;
  return {
    contents: [{ parts: [{ text: spec.prompt }, ...referenceParts] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        ...(controls.aspectRatio ? { aspectRatio: controls.aspectRatio } : {}),
        ...(imageSize ? { imageSize } : {}),
      },
    },
  };
}

/** OpenAI-Images-API-shaped response — GPT Image 2 (verified live 2026-07:
 * real paid calls returned `data[].b64_json`, distinct from the Gemini
 * chat/generateContent shape the rest of this file targets). */
interface ImagesGenerationsResponse {
  data?: { b64_json?: string }[];
}

interface GenerateContentPart {
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}
interface GenerateContentResponse {
  candidates?: { content?: { parts?: GenerateContentPart[] } }[];
}

export interface LaozhangClientOptions {
  baseUrl: string;
  apiKey: string;
  imageTimeoutMs?: number;
}

export class LaozhangClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly imageTimeoutMs: number;
  // undefined unless EGRESS_PROXY_URL is set → identical to today's direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: LaozhangClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.imageTimeoutMs = opts.imageTimeoutMs ?? IMAGE_TIMEOUT_MS;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.imageTimeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw classifyProviderError(
        0,
        'NETWORK',
        `POST ${path} network error: ${(err as Error).message}`,
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
        message: `POST ${path}: non-JSON response: ${(err as Error).message}; head=${text.slice(0, 160)}`,
      });
    }
  }

  /** Multipart POST — required for the OpenAI `/v1/images/edits` route, whose
   * reference images travel as file parts (not JSON). Body is hand-built so it
   * respects the same dispatcher/timeout as postJson. */
  private async postMultipart<T>(
    path: string,
    fields: Record<string, string>,
    files: Array<{ field: string; filename: string; contentType: string; bytes: Buffer }>,
  ): Promise<T> {
    // Cryptographically random boundary so crafted reference bytes cannot guess it
    // and terminate a part early (a predictable timestamp boundary is injectable).
    const boundary = `----lzform${randomUUID()}`;
    const chunks: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    }
    for (const file of files) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(file.bytes, Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${this.apiKey}`,
        },
        body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(this.imageTimeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw classifyProviderError(
        0,
        'NETWORK',
        `POST ${path} network error: ${(err as Error).message}`,
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
        message: `POST ${path}: non-JSON response: ${(err as Error).message}; head=${text.slice(0, 160)}`,
      });
    }
  }

  /** Gemini-native route — required for exact aspect/resolution controls. */
  generateContent(model: string, body: unknown): Promise<GenerateContentResponse> {
    return this.postJson(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, body);
  }

  /** GPT Image 2 text-to-image — OpenAI Images-API-shaped, distinct from the Gemini
   * paths above (verified live 2026-07: real paid calls returned `data[].b64_json`). */
  imagesGenerations(body: unknown): Promise<ImagesGenerationsResponse> {
    return this.postJson('/v1/images/generations', body);
  }

  /** GPT Image 2 image-to-image — OpenAI `/v1/images/edits` multipart route; the
   * references travel as `image` file parts. Same `data[].b64_json` response as
   * generations (PAID-verified 2026-07-20 — returned a real C2PA image). */
  imagesEdits(input: {
    model: string;
    prompt: string;
    quality?: string;
    size?: string;
    images: Array<{ bytes: Buffer; contentType: string; filename: string }>;
  }): Promise<ImagesGenerationsResponse> {
    return this.postMultipart(
      '/v1/images/edits',
      {
        model: input.model,
        prompt: input.prompt,
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.size ? { size: input.size } : {}),
      },
      input.images.map((img) => ({
        field: 'image',
        filename: img.filename,
        contentType: img.contentType,
        bytes: img.bytes,
      })),
    );
  }

  /** Reference images must travel as inline base64 on the native endpoint
   * (it doesn't fetch arbitrary URLs the way the OpenAI-compatible path does). */
  async fetchAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
    let res;
    try {
      res = await guardedRequest(url, {
        method: 'GET',
        signal: AbortSignal.timeout(30_000),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw classifyProviderError(
        0,
        'NETWORK',
        `fetch reference asset failed: ${(err as Error).message}`,
      );
    }
    if (res.statusCode >= 400) {
      throw classifyProviderError(
        res.statusCode,
        `HTTP_${res.statusCode}`,
        'reference asset fetch failed',
      );
    }
    const mimeType =
      (res.headers['content-type'] as string | undefined)?.split(';')[0] ?? 'image/jpeg';
    const buf = Buffer.from(await res.body.arrayBuffer());
    if (buf.byteLength > MAX_ASSET_BYTES) {
      throw new ProviderError({
        code: 'ASSET_TOO_LARGE',
        status: 413,
        retryable: false,
        message: `reference asset ${buf.byteLength} bytes exceeds ${MAX_ASSET_BYTES}`,
      });
    }
    return { data: buf.toString('base64'), mimeType };
  }
}

/** Models that speak the OpenAI Images API shape instead of the Gemini
 * chat/generateContent shapes the rest of this file targets. */
const OPENAI_IMAGE_MODELS = new Set(['gpt-image-2']);

export class LaozhangAdapter implements ProviderAdapter {
  constructor(private readonly client: LaozhangClient) {}

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind !== 'image' && spec.kind !== 'image-edit') {
      throw new Error(`laozhang adapter only supports image kinds, got: ${spec.kind}`);
    }
    const p = spec.params;
    const imageUrls = urlArr(p, 'imageUrls').length
      ? urlArr(p, 'imageUrls')
      : spec.referenceAssets.filter((u) => !/\.(mp4|mov|webm)(\?|$)/i.test(u));

    const assets = OPENAI_IMAGE_MODELS.has(spec.providerModelId)
      ? await this.generateOpenAIImage(spec, imageUrls)
      : await this.generateGemini(spec, imageUrls);

    if (assets.length === 0) {
      throw new ProviderError({
        code: 'NO_ASSET',
        status: 200,
        retryable: true,
        message: 'laozhang.ai returned no images',
      });
    }
    return {
      providerJobId: `lz-img-${Date.now().toString(36)}`,
      gateway: 'laozhang',
      inlineResult: { assets },
    };
  }

  private async generateGemini(
    spec: WorkflowSpec,
    imageUrls: string[],
  ): Promise<GenerationAsset[]> {
    const controls = workflowImageControls(spec);
    const n = Math.min(controls.count, MAX_IMAGE_BATCH);
    // The native route is required for exact aspect/resolution mapping. It also
    // accepts references as inline data, so all Board image jobs use one shape.
    const calls = Array.from({ length: n }, () => this.generateNative(spec, imageUrls));
    return oneAssetPerCall(await Promise.all(calls), 'laozhang.ai');
  }

  /** GPT Image 2 — text-to-image via `/v1/images/generations`, image-to-image via the
   * OpenAI `/v1/images/edits` multipart route when references are present (both
   * PAID-verified 2026-07-20). References ≤8 travel as `image` file parts. `quality`
   * (low/medium/high, the vendor's own values) is read directly off spec.params — NOT
   * workflowImageControls, whose `resolution` is typed to the 1K/2K/3K/4K pixel-tier
   * union and would silently drop a quality word (phase 1.1, 2026-07-28). `resolution`
   * is the primary key (matches /boards + priceSelectorFromParams' preference order);
   * `quality` stays a fallback for a stale/third-party caller sending the legacy alias
   * — either way, served == billed. */
  private async generateOpenAIImage(
    spec: WorkflowSpec,
    imageUrls: string[],
  ): Promise<GenerationAsset[]> {
    const n = Math.min(workflowImageControls(spec).count, MAX_IMAGE_BATCH);
    const body = buildLaozhangImageBody(spec);
    const refs = imageUrls.length
      ? await Promise.all(
          imageUrls.slice(0, MAX_REFERENCE_IMAGES).map(async (url, index) => {
            const { data, mimeType } = await this.client.fetchAsBase64(url);
            const bytes = Buffer.from(data, 'base64');
            if (bytes.byteLength > MAX_EDIT_REFERENCE_BYTES) {
              throw new ProviderError({
                code: 'ASSET_TOO_LARGE',
                status: 413,
                retryable: false,
                message: `gpt-image-2 edit reference ${bytes.byteLength} bytes exceeds ${MAX_EDIT_REFERENCE_BYTES}`,
              });
            }
            return {
              bytes,
              contentType: mimeType,
              filename: `ref-${index}.${extensionFromContentType(mimeType)}`,
            };
          }),
        )
      : null;
    const responses = await Promise.all(
      Array.from({ length: n }, () =>
        refs
          ? this.client.imagesEdits({
              model: body['model'] as string,
              prompt: body['prompt'] as string,
              ...(typeof body['quality'] === 'string' ? { quality: body['quality'] } : {}),
              ...(typeof body['size'] === 'string' ? { size: body['size'] } : {}),
              images: refs,
            })
          : this.client.imagesGenerations(body),
      ),
    );
    return oneAssetPerCall(
      responses.map((res) =>
        (res.data ?? [])
          .filter((d): d is { b64_json: string } => typeof d.b64_json === 'string')
          .map((d) => {
            const match = /^data:([^;,]+);base64,(.+)$/s.exec(d.b64_json);
            const encoded = match?.[2] ?? d.b64_json;
            return {
              bytes: Buffer.from(encoded, 'base64'),
              contentType: match?.[1] ?? 'image/png',
              extension: extensionFromContentType(match?.[1] ?? 'image/png'),
            };
          }),
      ),
      'laozhang.ai',
    );
  }

  private async generateNative(
    spec: WorkflowSpec,
    imageUrls: string[],
  ): Promise<GenerationAsset[]> {
    const refParts = await Promise.all(
      imageUrls.slice(0, MAX_REFERENCE_IMAGES).map(async (u) => {
        const { data, mimeType } = await this.client.fetchAsBase64(u);
        return { inlineData: { mimeType, data } };
      }),
    );
    const res = await this.client.generateContent(
      spec.providerModelId,
      buildLaozhangImageBody(spec, refParts),
    );
    const assets: GenerationAsset[] = [];
    for (const cand of res.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        const data = part.inlineData?.data ?? part.inline_data?.data;
        if (!data) continue;
        const mimeType = part.inlineData?.mimeType ?? part.inline_data?.mime_type ?? 'image/jpeg';
        assets.push({
          bytes: Buffer.from(data, 'base64'),
          contentType: mimeType,
          extension: extensionFromContentType(mimeType),
        });
      }
    }
    return assets;
  }

  async awaitResult(handle: GenerationHandle, _spec: WorkflowSpec): Promise<GenerationResult> {
    if (handle.inlineResult) return handle.inlineResult;
    throw new ProviderError({
      code: 'NO_INLINE_RESULT',
      status: 500,
      retryable: false,
      message: 'laozhang adapter is sync-only; generate() must attach an inlineResult',
    });
  }
}
