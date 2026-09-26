import { request, type Dispatcher } from 'undici';
import { egressDispatcher } from './egress';
import { classifyProviderError } from './adapter-helpers';
import { ProviderError } from './types';

/**
 * Pixazo client — the Seedance 2.0 Mini relay (docs/platform/vendor-api/pixazo-specs/
 * seedance.md, captured 2026-08-03; live 402 quote 2026-09-03 in
 * np8b-live-verification-2026-09-03.md). Async queue API:
 *
 *   POST https://gateway.pixazo.ai/{model}/{operation}  → 202 { request_id, status, polling_url }
 *   GET  https://gateway.pixazo.ai/v2/requests/status/{request_id}
 *        → { status: QUEUED|PROCESSING|COMPLETED|FAILED|ERROR, output: { media_url[] } }
 *
 * Auth is the `Ocp-Apim-Subscription-Key` header (Azure API Management), not Bearer.
 */

export const PIXAZO_DEFAULT_BASE = 'https://gateway.pixazo.ai';
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;

export type PixazoContentItem =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string };
      role?: 'first_frame' | 'last_frame';
    };

/** Submit body shared by `text-to-video` and `first-last-frame-to-video`. */
export interface PixazoVideoBody {
  content: PixazoContentItem[];
  ratio?: string;
  resolution: '480p' | '720p';
  duration: number;
  generate_audio: boolean;
  watermark: false;
}

export interface PixazoSubmitResponse {
  request_id?: string;
  status?: string;
  polling_url?: string;
  error?: string;
  message?: string;
}

export interface PixazoStatusResponse {
  request_id?: string;
  status?: string;
  model_id?: string;
  error?: string | null;
  output?: { media_url?: string[]; media_type?: string } | null;
}

export interface PixazoClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class PixazoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  // undefined unless EGRESS_PROXY_URL is set → identical to the direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: PixazoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
  }

  private async requestJson<T>(
    method: 'POST' | 'GET',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    let res;
    try {
      res = await request(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-cache',
          'ocp-apim-subscription-key': this.apiKey,
        },
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

  submit(model: string, operation: string, body: PixazoVideoBody): Promise<PixazoSubmitResponse> {
    return this.requestJson(
      'POST',
      `/${encodeURIComponent(model)}/${encodeURIComponent(operation)}`,
      body,
      SUBMIT_TIMEOUT_MS,
    );
  }

  status(requestId: string): Promise<PixazoStatusResponse> {
    return this.requestJson(
      'GET',
      `/v2/requests/status/${encodeURIComponent(requestId)}`,
      undefined,
      POLL_TIMEOUT_MS,
    );
  }
}
