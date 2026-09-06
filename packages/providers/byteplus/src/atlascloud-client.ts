import { request, type Dispatcher } from 'undici';
import { ProviderError } from './types';
import { guardedRequest } from './net-guard';
import { egressDispatcher } from './egress';

/**
 * AtlasCloud gateway client. Like Evolink, AtlasCloud is a fully ASYNC,
 * task-based gateway for BOTH image and video:
 *   POST /api/v1/model/generateImage|generateVideo  → PredictionResponse { id, status }
 *   GET  /api/v1/model/result/{id}                   → poll until status='completed'
 *
 * The completed prediction carries the asset URL(s) in `outputs[]`. Those are
 * public `static.atlascloud.ai` CDN URLs and must be fetched WITHOUT our Bearer
 * header (sending it can make the CDN reject the request).
 *
 * Contract verified live 2026-06-08 (catalog + static OpenAPI schema/example,
 * zero spend). See docs/platform/model-catalog.md.
 */

export interface AtlasCloudClientOptions {
  baseUrl: string;
  apiKey: string;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
}

/** The single response shape returned by BOTH submit and poll. */
export interface AtlasPrediction {
  id: string;
  status: 'created' | 'processing' | 'completed' | 'failed' | string;
  outputs?: string[];
  model?: string;
  created_at?: string;
  has_nsfw_contents?: boolean[];
  urls?: Record<string, unknown>;
  // Error surfaces vary; accept both a string and an object form.
  error?: { code?: string; message?: string } | string;
  msg?: string;
  code?: number | string;
}

const MAX_ASSET_BYTES = 500 * 1024 * 1024;

function safeParse<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ProviderError({
      code: 'PARSE_ERROR',
      status: 200,
      retryable: true,
      message: `${label}: non-JSON response: ${(err as Error).message}; head=${text.slice(0, 160)}`,
    });
  }
}

/**
 * AtlasCloud wraps every prediction in a `{ code, message, data }` envelope —
 * the id / status / outputs live under `data`, NOT at the top level. Unwrap it
 * (tolerant of a flat shape) and surface envelope-level errors: the API returns
 * HTTP 200 with a non-2xx `code` for some failures.
 */
function unwrap(label: string, text: string): AtlasPrediction {
  const env = safeParse<{ code?: number | string; message?: string; data?: AtlasPrediction }>(
    label,
    text,
  );
  const codeNum = Number(env.code);
  if (Number.isFinite(codeNum) && codeNum >= 400) {
    throw classify(codeNum, `HTTP_${codeNum}`, env.message || `${label}: code ${codeNum}`);
  }
  return env.data ?? (env as unknown as AtlasPrediction);
}

function classify(status: number, code: string, message: string): ProviderError {
  // status 0 = network/timeout; treat those + 408/429/5xx as transient so the
  // job retries instead of failing (mirror evolink-client classification).
  const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  return new ProviderError({ code, status, retryable, message });
}

export class AtlasCloudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly submitTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  // undefined unless EGRESS_PROXY_URL is set → identical to today's direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: AtlasCloudClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.submitTimeoutMs = opts.submitTimeoutMs ?? 30_000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  /** Submit a generation task; returns the prediction envelope (id + status). */
  async submit(path: string, body: unknown): Promise<AtlasPrediction> {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await request(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.submitTimeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw classify(0, 'NETWORK', `POST ${path} network error: ${(err as Error).message}`);
    }
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw classify(res.statusCode, `HTTP_${res.statusCode}`, text.slice(0, 500));
    }
    return unwrap(`POST ${path}`, text);
  }

  /** Poll a prediction by id. */
  async getResult(id: string): Promise<AtlasPrediction> {
    const url = `${this.baseUrl}/model/result/${id}`;
    let res;
    try {
      res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.pollTimeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw classify(
        0,
        'NETWORK',
        `GET /model/result/${id} network error: ${(err as Error).message}`,
      );
    }
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw classify(res.statusCode, `HTTP_${res.statusCode}`, text.slice(0, 500));
    }
    return unwrap(`GET /model/result/${id}`, text);
  }

  /**
   * Download a result asset. AtlasCloud returns public CDN URLs that already
   * carry their own access — sending our Bearer token can make the CDN reject
   * the request, so we fetch these clean.
   */
  async fetchAsset(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    // BL-5: SSRF guard — refuse private/loopback/link-local targets before any
    // socket, and pin a rebinding-safe dispatcher for the fetch itself.
    const res = await guardedRequest(url, {
      method: 'GET',
      signal: AbortSignal.timeout(120_000), // videos can be several MB
      // When egress is on, the CDN download tunnels through the same proxy;
      // assertUrlPublic still pre-screens the URL and the proxy is CONNECT-:443
      // + private-range-deny locked, so SSRF stays fail-closed. When off →
      // undefined → guardedRequest keeps its rebinding-safe agent (unchanged).
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    if (res.statusCode >= 400) {
      throw classify(res.statusCode, `HTTP_${res.statusCode}`, 'fetchAsset failed');
    }
    const contentType =
      (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      throw new ProviderError({
        code: 'ASSET_TOO_LARGE',
        status: 413,
        retryable: false,
        message: `asset content-length ${declared} exceeds ${MAX_ASSET_BYTES}`,
      });
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
    return { bytes: buf, contentType };
  }
}
