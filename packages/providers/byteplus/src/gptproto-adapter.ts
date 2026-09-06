import { request, type Dispatcher } from 'undici';
import type { GenerationHandle, GenerationResult, ProviderAdapter, WorkflowSpec } from './types';
import { ProviderError, workflowImageControls } from './types';
import { classifyProviderError, extensionFromContentType, urlArr } from './adapter-helpers';
import { guardedRequest } from './net-guard';
import { egressDispatcher } from './egress';
import {
  GptprotoClient,
  type GptprotoResultResponse,
  type GptprotoSubmitBody,
} from './gptproto-client';

/**
 * GPTProto adapter — the Gemini-image family over gptproto.com's
 * `/api/v3/google/{model}/{scene}` relay (image + image-edit kinds only).
 *
 * Async by contract: submit with `enable_sync_mode:false`, keep the prediction
 * id on the handle, resolve in `awaitResult()` by polling
 * `/api/v3/predictions/{id}/result`, then download the vendor-hosted output
 * URLs through the guarded path. The id IS durable (the vendor hosts it), so
 * this gateway is admitted to RESUMABLE_GATEWAYS — a BullMQ retry resumes the
 * poll instead of submitting a second paid job.
 *
 * n>1 images fan out to n submits at `generate()` time (each submit is one
 * billed generation, like every relay) and the ids ride together inside
 * `providerJobId` using the same `gp-batch:` encoding kie uses.
 *
 * Scene mapping (vendor doc 2026-09-03): `text-to-image` with no references,
 * `image-edit` with `images: [public URLs]`. Size is the 1K/2K/4K tier the
 * catalog already sells NB Pro in; aspect_ratio is the Board control verbatim.
 */

export const GP_BATCH_PREFIX = 'gp-batch:';
const MAX_IMAGE_BATCH = 4;
const MAX_REFERENCE_IMAGES = 8;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'canceled']);
const POLL_INTERVAL_MS = 3_000;
const POLL_DEADLINE_MS = 10 * 60_000;

function encodePredictionIds(ids: string[]): string {
  return ids.length === 1 ? ids[0]! : `${GP_BATCH_PREFIX}${ids.map(encodeURIComponent).join(',')}`;
}

function decodePredictionIds(value: string): string[] {
  if (!value.startsWith(GP_BATCH_PREFIX)) return [value];
  return value.slice(GP_BATCH_PREFIX.length).split(',').filter(Boolean).map(decodeURIComponent);
}

/** Pure body builder — catalog/conformance tests inspect it without network. */
export function buildGptprotoImageBody(spec: WorkflowSpec): GptprotoSubmitBody {
  const controls = workflowImageControls(spec);
  const imageUrls = imageUrlsFor(spec);
  return {
    prompt: spec.prompt,
    output_format: 'png',
    ...(controls.aspectRatio ? { aspect_ratio: controls.aspectRatio } : {}),
    ...(controls.resolution ? { size: controls.resolution } : {}),
    ...(imageUrls.length ? { images: imageUrls.slice(0, MAX_REFERENCE_IMAGES) } : {}),
    enable_sync_mode: false,
  };
}

function imageUrlsFor(spec: WorkflowSpec): string[] {
  const fromParams = urlArr(spec.params, 'imageUrls');
  if (fromParams.length) return fromParams;
  return spec.referenceAssets.filter((u) => !/\.(mp4|mov|webm)(\?|$)/i.test(u));
}

export class GptprotoAdapter implements ProviderAdapter {
  // undefined unless EGRESS_PROXY_URL is set → identical to the direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(
    private readonly client: GptprotoClient,
    opts: { pollIntervalMs?: number; pollDeadlineMs?: number } = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollDeadlineMs = opts.pollDeadlineMs ?? POLL_DEADLINE_MS;
  }

  private readonly pollIntervalMs: number;
  private readonly pollDeadlineMs: number;

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind !== 'image' && spec.kind !== 'image-edit') {
      throw new Error(`gptproto adapter only supports image kinds, got: ${spec.kind}`);
    }
    const count = Math.min(workflowImageControls(spec).count, MAX_IMAGE_BATCH);
    const scene = imageUrlsFor(spec).length ? 'image-edit' : 'text-to-image';
    const body = buildGptprotoImageBody(spec);
    const responses = await Promise.all(
      Array.from({ length: count }, () => this.client.submit(scene, spec.providerModelId, body)),
    );
    const ids = responses.map((res) => {
      const id = res.data?.id;
      if (!id) {
        throw new ProviderError({
          code: 'NO_TASK_ID',
          status: res.code ?? 200,
          retryable: true,
          message: `gptproto submit (${scene}) returned no prediction id: ${(res.message ?? '').slice(0, 200)}`,
        });
      }
      return id;
    });
    return { providerJobId: encodePredictionIds(ids), gateway: 'gptproto' };
  }

  async awaitResult(handle: GenerationHandle, _spec: WorkflowSpec): Promise<GenerationResult> {
    const ids = decodePredictionIds(handle.providerJobId);
    const deadline = Date.now() + this.pollDeadlineMs;
    const nsfw = new Map<number, boolean>();
    for (;;) {
      const results = await Promise.all(ids.map((id) => this.client.result(id)));
      const done = results.every((res) => {
        const status = (res.data?.status ?? '').toLowerCase();
        return TERMINAL_STATUSES.has(status);
      });
      if (done) {
        const assets = [];
        for (const [index, res] of results.entries()) {
          const status = (res.data?.status ?? '').toLowerCase();
          if (status !== 'completed' && status !== 'succeeded') {
            throw new ProviderError({
              code: 'SUBMIT_REJECTED',
              status: 400,
              retryable: false,
              message: `gptproto prediction ${ids[index]} ended ${status}: ${(res.data?.error ?? res.message ?? '').slice(0, 300)}`,
            });
          }
          const outputs = (res.data?.outputs ?? []).filter(
            (u): u is string => typeof u === 'string' && u.length > 0,
          );
          if (outputs.length === 0) {
            throw new ProviderError({
              code: 'NO_ASSET',
              status: 200,
              retryable: true,
              message: `gptproto prediction ${ids[index]} completed with no outputs`,
            });
          }
          (res.data?.has_nsfw_contents ?? []).forEach((flag, i) => {
            if (flag === true) nsfw.set(index, true);
          });
          for (const url of outputs) {
            const fetched = await this.fetchAsset(url);
            assets.push({
              bytes: fetched.bytes,
              contentType: fetched.contentType,
              extension: extensionFromContentType(fetched.contentType),
            });
          }
        }
        return {
          assets,
          meta: { provider: 'gptproto', ...(nsfw.size ? { nsfw: true } : {}) },
        };
      }
      if (Date.now() > deadline) {
        throw new ProviderError({
          code: 'POLL_UNREACHABLE',
          status: 408,
          retryable: true,
          message: `gptproto predictions ${handle.providerJobId} unfinished after ${this.pollDeadlineMs / 1000}s`,
        });
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  /** Vendor-hosted output download — same guarded + egress shape as AtlasCloud. */
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
