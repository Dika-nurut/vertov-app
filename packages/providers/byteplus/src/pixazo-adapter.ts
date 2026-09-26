import { type Dispatcher } from 'undici';
import type { GenerationHandle, GenerationResult, ProviderAdapter, WorkflowSpec } from './types';
import { ProviderError, workflowFrameImages } from './types';
import { classifyProviderError, extensionFromContentType, urlArr } from './adapter-helpers';
import { guardedRequest } from './net-guard';
import { egressDispatcher } from './egress';
import { PixazoClient, type PixazoContentItem, type PixazoVideoBody } from './pixazo-client';

/**
 * Pixazo adapter — Seedance 2.0 Mini (`seedance-2-0-mini`), text-to-video and
 * first/last-frame image-to-video. Both operations bill the same per-second rate
 * (vendor card), so they share one catalogue row.
 *
 * Billing note that the price has to carry: Pixazo bills actual output seconds
 * ROUNDED UP, and a clip usually runs ~0.1 s long, so a 5 s request bills 6 s.
 * The adapter therefore never asks for `duration: -1` (auto length); the
 * requested length is the one the catalogue quoted.
 *
 * Async by contract: the `request_id` is durable on the vendor, so the gateway is
 * resumable — a worker retry polls the same id instead of paying twice. Terminal
 * `ERROR` is documented as "not charged"; `FAILED` is not, so both refund the
 * customer but only ERROR is safe to treat as unbilled upstream.
 */

const RESOLUTIONS = new Set(['480p', '720p']);
const RATIOS = new Set(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);
const MIN_DURATION_S = 4;
const MAX_DURATION_S = 15;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const POLL_INTERVAL_MS = 5_000;
const POLL_DEADLINE_MS = 15 * 60_000;

export interface PixazoSubmit {
  operation: 'text-to-video' | 'first-last-frame-to-video';
  body: PixazoVideoBody;
}

function refuse(message: string): never {
  throw new ProviderError({ code: 'INVALID_REQUEST', status: 400, retryable: false, message });
}

/** Pure request builder — conformance tests inspect it without network. */
export function buildPixazoSeedanceMini(spec: WorkflowSpec): PixazoSubmit {
  const p = spec.params;
  if (
    urlArr(p, 'videoUrls').length > 0 ||
    urlArr(p, 'audioUrls').length > 0 ||
    spec.referenceAssets.some((url) => /\.(mp4|mov|webm|mp3|wav|m4a)(\?|$)/i.test(url))
  ) {
    refuse('pixazo seedance mini: video/audio references are not sold on this row');
  }

  const resolution = typeof p['resolution'] === 'string' ? p['resolution'] : '480p';
  // Fail closed: silently coercing to the vendor default (720p) would deliver and
  // bill a dearer rung than the one the customer was charged for.
  if (!RESOLUTIONS.has(resolution)) refuse(`pixazo seedance mini: resolution ${resolution}`);

  const maxDuration = Math.min(spec.maxDurationSeconds ?? MAX_DURATION_S, MAX_DURATION_S);
  const requested = typeof p['duration_seconds'] === 'number' ? p['duration_seconds'] : 5;
  // ceil matches billing's Math.ceil(duration); never below the 4 s vendor minimum.
  const duration = Math.min(maxDuration, Math.max(MIN_DURATION_S, Math.ceil(requested)));

  // Absent → 16:9 like every Seedance route; an off-menu ratio is omitted (vendor adaptive).
  const ratio = typeof p['aspect_ratio'] === 'string' ? p['aspect_ratio'] : '16:9';
  const frames = workflowFrameImages(spec);
  const content: PixazoContentItem[] = [];
  if (spec.prompt.trim()) content.push({ type: 'text', text: spec.prompt });
  if (frames.length > 0) {
    const two = frames.length > 1;
    for (const frame of frames) {
      content.push({
        type: 'image_url',
        image_url: { url: frame.url },
        ...(two ? { role: frame.role === 'first' ? 'first_frame' : 'last_frame' } : {}),
      });
    }
  } else if (content.length === 0) {
    refuse('pixazo seedance mini: a text-to-video request needs a prompt');
  }

  return {
    operation: frames.length > 0 ? 'first-last-frame-to-video' : 'text-to-video',
    body: {
      content,
      ...(ratio && RATIOS.has(ratio) ? { ratio } : {}),
      resolution: resolution as '480p' | '720p',
      duration,
      generate_audio: p['generate_audio'] !== false,
      watermark: false,
    },
  };
}

export class PixazoAdapter implements ProviderAdapter {
  // undefined unless EGRESS_PROXY_URL is set → identical to the direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();
  private readonly pollIntervalMs: number;
  private readonly pollDeadlineMs: number;

  constructor(
    private readonly client: PixazoClient,
    opts: { pollIntervalMs?: number; pollDeadlineMs?: number } = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollDeadlineMs = opts.pollDeadlineMs ?? POLL_DEADLINE_MS;
  }

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind !== 'video') {
      throw new Error(`pixazo adapter only supports video, got: ${spec.kind}`);
    }
    const { operation, body } = buildPixazoSeedanceMini(spec);
    const res = await this.client.submit(spec.providerModelId, operation, body);
    if (!res.request_id) {
      throw new ProviderError({
        code: 'NO_TASK_ID',
        status: 200,
        retryable: true,
        message: `pixazo submit (${operation}) returned no request_id: ${(res.message ?? res.error ?? '').slice(0, 200)}`,
      });
    }
    return { providerJobId: res.request_id, gateway: 'pixazo' };
  }

  async awaitResult(handle: GenerationHandle, _spec: WorkflowSpec): Promise<GenerationResult> {
    const deadline = Date.now() + this.pollDeadlineMs;
    for (;;) {
      const res = await this.client.status(handle.providerJobId);
      const status = (res.status ?? '').toUpperCase();
      if (status === 'COMPLETED') {
        const url = (res.output?.media_url ?? []).find(
          (u): u is string => typeof u === 'string' && u.length > 0,
        );
        if (!url) {
          throw new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: true,
            message: `pixazo request ${handle.providerJobId} completed with no media_url`,
          });
        }
        const fetched = await this.fetchAsset(url);
        return {
          assets: [
            {
              bytes: fetched.bytes,
              contentType: fetched.contentType,
              extension: extensionFromContentType(fetched.contentType),
            },
          ],
          meta: { provider: 'pixazo' },
        };
      }
      if (status === 'FAILED' || status === 'ERROR') {
        throw new ProviderError({
          code: 'SUBMIT_REJECTED',
          status: 400,
          retryable: false,
          message: `pixazo request ${handle.providerJobId} ended ${status}: ${(res.error ?? '').slice(0, 300)}`,
        });
      }
      if (Date.now() > deadline) {
        throw new ProviderError({
          code: 'POLL_UNREACHABLE',
          status: 408,
          retryable: true,
          message: `pixazo request ${handle.providerJobId} unfinished after ${this.pollDeadlineMs / 1000}s`,
        });
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  /** Vendor-hosted output download (r2.dev) through the SSRF guard + egress. */
  async fetchAsset(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    let res;
    try {
      res = await guardedRequest(url, {
        method: 'GET',
        signal: AbortSignal.timeout(120_000),
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
      (res.headers['content-type'] as string | undefined)?.split(';')[0] ?? 'video/mp4';
    return { bytes: buf, contentType };
  }
}
