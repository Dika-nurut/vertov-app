import { request, type Dispatcher } from 'undici';
import { guardedRequest } from './net-guard';
import { egressDispatcher } from './egress';
import { ProviderError } from './types';

export interface BytePlusClientOptions {
  baseUrl: string;
  apiKey: string;
  imageTimeoutMs?: number;
  videoPollTimeoutMs?: number;
}

export interface BytePlusImageResponse {
  data: Array<{ url: string; seed?: number; b64_json?: string }>;
  /**
   * BytePlus returns a vendor-specific object here, but no stable schema or
   * captured invoice field is established in this repository yet. Preserve it
   * verbatim; callers must not treat it as a normalized cost.
   */
  usage?: Record<string, unknown>;
}

export interface BytePlusVideoTask {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  content?: { video_url?: string; cover_url?: string };
  error?: { code: string; message: string };
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
      message: `${label}: non-JSON response: ${(err as Error).message}; head=${text.slice(0, 120)}`,
    });
  }
}

function classify(status: number, code: string, message: string): ProviderError {
  // 408/429/5xx are retryable; 4xx are not.
  const retryable = status === 408 || status === 429 || status >= 500;
  return new ProviderError({ code, status, retryable, message });
}

export class BytePlusClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly imageTimeoutMs: number;
  private readonly videoPollTimeoutMs: number;
  // undefined unless EGRESS_PROXY_URL is set → identical to today's direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: BytePlusClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.imageTimeoutMs = opts.imageTimeoutMs ?? 30_000;
    this.videoPollTimeoutMs = opts.videoPollTimeoutMs ?? 15_000;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await request(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw classify(0, 'NETWORK', `POST ${path} network error: ${(err as Error).message}`);
    }
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw classify(res.statusCode, `HTTP_${res.statusCode}`, text.slice(0, 500));
    }
    return safeParse<T>(`POST ${path}`, text);
  }

  private async get<T>(path: string, timeoutMs: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw classify(0, 'NETWORK', `GET ${path} network error: ${(err as Error).message}`);
    }
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw classify(res.statusCode, `HTTP_${res.statusCode}`, text.slice(0, 500));
    }
    return safeParse<T>(`GET ${path}`, text);
  }

  createImage(endpoint: string, body: unknown): Promise<BytePlusImageResponse> {
    return this.post<BytePlusImageResponse>(endpoint, body, this.imageTimeoutMs);
  }

  createVideoTask(endpoint: string, body: unknown): Promise<BytePlusVideoTask> {
    return this.post<BytePlusVideoTask>(endpoint, body, this.videoPollTimeoutMs);
  }

  getVideoTask(endpoint: string, id: string): Promise<BytePlusVideoTask> {
    return this.get<BytePlusVideoTask>(`${endpoint}/${id}`, this.videoPollTimeoutMs);
  }

  async fetchAsset(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    // BL-5: SSRF guard — refuse private/loopback/link-local targets before any
    // socket and pin a rebinding-safe dispatcher (a provider-returned URL must
    // never be able to point the worker at 169.254.169.254/internal services).
    // Matches evolink-client.ts / atlascloud-client.ts; the post/get calls above
    // hit our configured trusted base URL so they stay on raw request().
    // BytePlus signed URLs ignore extra headers; unsigned CDN paths still
    // require our Bearer token. Sending headers either way is safe.
    const res = await guardedRequest(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.imageTimeoutMs),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    if (res.statusCode >= 400) {
      throw classify(res.statusCode, `HTTP_${res.statusCode}`, `fetchAsset failed`);
    }
    const contentType =
      (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
    // Refuse pathologically large downloads — a hostile or runaway provider
    // shouldn't be able to OOM the worker.
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
