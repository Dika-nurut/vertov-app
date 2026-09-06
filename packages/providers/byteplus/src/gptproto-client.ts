import { request, type Dispatcher } from 'undici';
import { egressDispatcher } from './egress';
import { classifyProviderError } from './adapter-helpers';
import { ProviderError } from './types';

/**
 * GPTProto client — the Gemini-image relay used as the third leg of the
 * nano-banana family (NB Pro $0.0804 1K/2K, $0.144 4K; NB-2 $0.0402; verified
 * against the vendor's own model pages 2026-09-03, key valid, 402 without
 * balance). OpenAI-flavored JSON: POST /api/v3/google/{model}/{scene}, then
 * poll GET /api/v3/predictions/{id}/result until status is terminal.
 */

export const GPTPROTO_DEFAULT_BASE = 'https://gptproto.com';
const IMAGE_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 30_000;

/** Submit body — POST /api/v3/google/{model}/{scene}. */
export interface GptprotoSubmitBody {
  prompt: string;
  output_format?: string;
  aspect_ratio?: string;
  size?: string;
  /** Reference image URLs for the image-edit scene (public URLs). */
  images?: string[];
  /** Keep the async flow: submit returns an id, we poll for the result. */
  enable_sync_mode: false;
}

export interface GptprotoSubmitResponse {
  data?: {
    id?: string;
    status?: string;
    error?: string | null;
    /** `urls.get` embeds the prediction id — accepted as the poll target too. */
    urls?: { get?: string };
  };
  message?: string;
  code?: number;
}

export interface GptprotoResultResponse {
  data?: {
    id?: string;
    status?: string;
    error?: string | null;
    /** Output URLs (hosted files). Populated on completion. */
    outputs?: string[];
    /** Vendor NSFW flags, parallel to `outputs` (recorded, not enforced — M-1). */
    has_nsfw_contents?: boolean[];
  };
  message?: string;
  code?: number;
}

export interface GptprotoClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class GptprotoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  // undefined unless EGRESS_PROXY_URL is set → identical to the direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: GptprotoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
  }

  private async requestJson<T>(
    method: 'POST' | 'GET',
    path: string,
    body?: unknown,
    timeoutMs = IMAGE_TIMEOUT_MS,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await request(url, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
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

  submit(
    scene: string,
    providerModelId: string,
    body: GptprotoSubmitBody,
  ): Promise<GptprotoSubmitResponse> {
    return this.requestJson(
      'POST',
      `/api/v3/google/${encodeURIComponent(providerModelId)}/${scene}`,
      body,
    );
  }

  result(predictionId: string): Promise<GptprotoResultResponse> {
    return this.requestJson(
      'GET',
      `/api/v3/predictions/${encodeURIComponent(predictionId)}/result`,
      undefined,
      POLL_TIMEOUT_MS,
    );
  }
}
