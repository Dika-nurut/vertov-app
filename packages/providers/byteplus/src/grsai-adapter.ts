import { type Dispatcher } from 'undici';
import type { GenerationHandle, GenerationResult, ProviderAdapter, WorkflowSpec } from './types';
import { ProviderError, workflowImageControls } from './types';
import { classifyProviderError, extensionFromContentType, urlArr } from './adapter-helpers';
import { guardedRequest } from './net-guard';
import { egressDispatcher } from './egress';
import {
  GrsaiClient,
  type GrsaiDrawBody,
  type GrsaiEnvelope,
  type GrsaiResult,
} from './grsai-client';

/**
 * Grsai adapter — the Nano Banana family over grsai's `/v1/draw/nano-banana` relay
 * (image + image-edit). Candidate leg: registered here, routed only once the workbook
 * carries a signed Grsai leg (it bills in yuan, so it needs a landed ₽/¥ channel rate).
 *
 * Async: submit with `webHook: "-1"` returns a durable task id, `awaitResult()` polls
 * `/v1/draw/result`. n>1 fans out to n submits (each one billed request), with the ids
 * packed into `providerJobId` using the same batch encoding GPTProto uses.
 */

export const GRSAI_BATCH_PREFIX = 'gr-batch:';
const MAX_IMAGE_BATCH = 4;
const MAX_REFERENCE_IMAGES = 8;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const POLL_INTERVAL_MS = 3_000;
const POLL_DEADLINE_MS = 10 * 60_000;
const ASPECTS = new Set([
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '21:9',
]);

/** Vertov catalogue id → Grsai model. Only the plain (same-price-every-size) models. */
export const GRSAI_MODEL_FOR: Readonly<Record<string, string>> = {
  'gemini-3-pro-image': 'nano-banana-pro',
  'gemini-3-1-flash-image': 'nano-banana-2',
  'gemini-2-5-flash-image': 'nano-banana-fast',
};

function refuse(message: string): never {
  throw new ProviderError({ code: 'MODEL_UNAVAILABLE', status: 400, retryable: false, message });
}

/** Pure body builder — conformance tests inspect it without network. */
export function buildGrsaiDrawBody(spec: WorkflowSpec): GrsaiDrawBody {
  const model = GRSAI_MODEL_FOR[spec.modelId];
  if (!model) refuse(`grsai: no Grsai route for ${spec.modelId}`);
  const controls = workflowImageControls(spec);
  const urls = (
    urlArr(spec.params, 'imageUrls').length
      ? urlArr(spec.params, 'imageUrls')
      : spec.referenceAssets.filter((u) => !/\.(mp4|mov|webm)(\?|$)/i.test(u))
  ).slice(0, MAX_REFERENCE_IMAGES);
  const aspect =
    controls.aspectRatio && ASPECTS.has(controls.aspectRatio) ? controls.aspectRatio : undefined;
  if (controls.resolution === '3K') refuse('grsai: 3K is not a Grsai size');
  const size = controls.resolution;
  return {
    model,
    prompt: spec.prompt,
    ...(urls.length ? { urls } : {}),
    ...(aspect ? { aspectRatio: aspect } : {}),
    // nano-banana-fast (2.5 Flash) has no size control on this route.
    ...(size && model !== 'nano-banana-fast' ? { imageSize: size } : {}),
    webHook: '-1',
    shutProgress: true,
  };
}

function encodeIds(ids: string[]): string {
  return ids.length === 1
    ? ids[0]!
    : `${GRSAI_BATCH_PREFIX}${ids.map(encodeURIComponent).join(',')}`;
}

function decodeIds(value: string): string[] {
  if (!value.startsWith(GRSAI_BATCH_PREFIX)) return [value];
  return value.slice(GRSAI_BATCH_PREFIX.length).split(',').filter(Boolean).map(decodeURIComponent);
}

export class GrsaiAdapter implements ProviderAdapter {
  // undefined unless EGRESS_PROXY_URL is set → identical to the direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();
  private readonly pollIntervalMs: number;
  private readonly pollDeadlineMs: number;

  constructor(
    private readonly client: GrsaiClient,
    opts: { pollIntervalMs?: number; pollDeadlineMs?: number } = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollDeadlineMs = opts.pollDeadlineMs ?? POLL_DEADLINE_MS;
  }

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind !== 'image' && spec.kind !== 'image-edit') {
      throw new Error(`grsai adapter only supports image kinds, got: ${spec.kind}`);
    }
    const body = buildGrsaiDrawBody(spec);
    const count = Math.min(workflowImageControls(spec).count, MAX_IMAGE_BATCH);
    const responses = await Promise.all(
      Array.from({ length: count }, () => this.client.submit(body)),
    );
    const ids = responses.map((res) => {
      // Live 2026-09-25: an empty wallet answers HTTP 200 with {code:-1, msg:"insufficient
      // credits"}. That is a provably unbilled refusal, not a transient glitch — surface it
      // as 402 so it is never retried as if the vendor might have charged.
      if (res.code !== 0 && /insufficient/i.test(res.msg ?? '')) {
        throw new ProviderError({
          code: 'INSUFFICIENT_BALANCE',
          status: 402,
          retryable: false,
          message: `grsai: ${res.msg}`,
        });
      }
      const id = res.data?.id;
      if (res.code !== 0 || !id) {
        throw new ProviderError({
          code: 'NO_TASK_ID',
          status: 200,
          retryable: true,
          message: `grsai submit returned no id (code ${String(res.code)}): ${(res.msg ?? '').slice(0, 200)}`,
        });
      }
      return id;
    });
    return { providerJobId: encodeIds(ids), gateway: 'grsai' };
  }

  async awaitResult(handle: GenerationHandle, _spec: WorkflowSpec): Promise<GenerationResult> {
    const ids = decodeIds(handle.providerJobId);
    const deadline = Date.now() + this.pollDeadlineMs;
    for (;;) {
      const results: GrsaiEnvelope<GrsaiResult>[] = await Promise.all(
        ids.map((id) => this.client.result(id)),
      );
      const statuses = results.map((res) => (res.data?.status ?? '').toLowerCase());
      const failedAt = statuses.findIndex((status) => status === 'failed');
      if (failedAt >= 0) {
        const data = results[failedAt]!.data;
        throw new ProviderError({
          code: 'SUBMIT_REJECTED',
          status: 400,
          retryable: false,
          message: `grsai task ${ids[failedAt]} failed (${data?.failure_reason ?? 'unknown'}): ${(data?.error ?? '').slice(0, 300)}`,
        });
      }
      if (statuses.every((status) => status === 'succeeded')) {
        const assets = [];
        for (const [index, res] of results.entries()) {
          const urls = (res.data?.results ?? [])
            .map((r) => r.url)
            .filter((u): u is string => typeof u === 'string' && u.length > 0);
          if (urls.length === 0) {
            throw new ProviderError({
              code: 'NO_ASSET',
              status: 200,
              retryable: true,
              message: `grsai task ${ids[index]} succeeded with no result url`,
            });
          }
          for (const url of urls) {
            const fetched = await this.fetchAsset(url);
            assets.push({
              bytes: fetched.bytes,
              contentType: fetched.contentType,
              extension: extensionFromContentType(fetched.contentType),
            });
          }
        }
        return { assets, meta: { provider: 'grsai' } };
      }
      if (Date.now() > deadline) {
        throw new ProviderError({
          code: 'POLL_UNREACHABLE',
          status: 408,
          retryable: true,
          message: `grsai tasks ${handle.providerJobId} unfinished after ${this.pollDeadlineMs / 1000}s`,
        });
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  /** Result URLs expire in two hours — download through the SSRF guard right away. */
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
      throw classifyProviderError(0, 'NETWORK', `asset download failed: ${(err as Error).message}`);
    }
    if (res.statusCode >= 400) {
      throw classifyProviderError(
        res.statusCode,
        `HTTP_${res.statusCode}`,
        'asset download failed',
      );
    }
    const buf = Buffer.from(await res.body.arrayBuffer());
    if (buf.byteLength > MAX_ASSET_BYTES) {
      throw new ProviderError({
        code: 'ASSET_TOO_LARGE',
        status: 413,
        retryable: false,
        message: `asset bytes ${buf.byteLength} exceeds ${MAX_ASSET_BYTES}`,
      });
    }
    const contentType =
      (res.headers['content-type'] as string | undefined)?.split(';')[0] ?? 'image/png';
    return { bytes: buf, contentType };
  }
}
