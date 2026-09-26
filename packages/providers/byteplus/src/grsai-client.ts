import { request, type Dispatcher } from 'undici';
import { egressDispatcher } from './egress';
import { classifyProviderError } from './adapter-helpers';
import { ProviderError } from './types';

/**
 * Grsai client — Nano Banana family relay (docs/platform/vendor-api/grsai-specs/
 * nano-banana.md, captured 2026-09-25). Billed in yuan: NB Pro ¥0.09, NB-2 ¥0.06,
 * NB fast ¥0.022 per request, every resolution the same price; errors and moderation
 * refusals are refunded by the vendor.
 *
 *   POST /v1/draw/nano-banana  { model, prompt, urls?, aspectRatio?, imageSize?,
 *                                webHook: "-1", shutProgress: true }
 *        → { code: 0, data: { id } }            (webHook "-1" = return an id, poll)
 *   POST /v1/draw/result        { id }
 *        → { code, data: { status: running|succeeded|failed, results[{url}], failure_reason } }
 *
 * Result URLs expire after two hours, so the adapter downloads on completion.
 */

export const GRSAI_DEFAULT_BASE = 'https://grsaiapi.com';
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;

export interface GrsaiDrawBody {
  model: string;
  prompt: string;
  urls?: string[];
  aspectRatio?: string;
  imageSize?: '1K' | '2K' | '4K';
  /** "-1" asks for an id immediately instead of a progress stream. */
  webHook: '-1';
  shutProgress: true;
}

export interface GrsaiResult {
  id?: string;
  results?: { url?: string; content?: string }[];
  progress?: number;
  status?: string;
  failure_reason?: string;
  error?: string;
}

export interface GrsaiEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

export interface GrsaiClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class GrsaiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  // undefined unless EGRESS_PROXY_URL is set → identical to the direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: GrsaiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    let res;
    try {
      res = await request(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
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

  submit(body: GrsaiDrawBody): Promise<GrsaiEnvelope<{ id?: string }>> {
    return this.post('/v1/draw/nano-banana', body, SUBMIT_TIMEOUT_MS);
  }

  result(id: string): Promise<GrsaiEnvelope<GrsaiResult>> {
    return this.post('/v1/draw/result', { id }, POLL_TIMEOUT_MS);
  }
}
