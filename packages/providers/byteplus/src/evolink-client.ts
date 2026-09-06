import { request, type Dispatcher } from 'undici';
import { ProviderError } from './types';
import { guardedRequest } from './net-guard';
import { egressDispatcher } from './egress';

/**
 * Evolink.ai gateway client. Unlike the direct BytePlus Ark client, Evolink is
 * a fully ASYNC, task-based gateway for BOTH image and video:
 *   POST /v1/images|videos/generations  → { id, status }
 *   GET  /v1/tasks/{id}                  → poll until status='completed'
 * The completed task carries the asset URL(s) in `result_data[].url`
 * (mirrored in `results[]`). Those are presigned TOS URLs (volces.com, valid
 * 24h) and must be fetched WITHOUT our Bearer header.
 */

export interface EvolinkClientOptions {
  baseUrl: string;
  apiKey: string;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
}

export interface EvolinkTask {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | string;
  progress?: number;
  result_data?: Array<{ url: string }>;
  results?: string[];
  error?: { code?: string; message?: string } | string;
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

function classify(status: number, code: string, message: string): ProviderError {
  // status 0 = network/timeout (the EU↔Evolink link blips on long video jobs);
  // treat those + 408/429/5xx as transient so the job retries instead of failing.
  const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  return new ProviderError({ code, status, retryable, message });
}

export class EvolinkClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly submitTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  // undefined unless EGRESS_PROXY_URL is set → identical to today's direct path.
  private readonly dispatcher: Dispatcher | undefined = egressDispatcher();

  constructor(opts: EvolinkClientOptions) {
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

  /** Submit a generation task; returns the task envelope (id + initial status). */
  async submit(path: string, body: unknown): Promise<EvolinkTask> {
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
    return safeParse<EvolinkTask>(`POST ${path}`, text);
  }

  /** Poll a task by id. */
  async getTask(taskId: string): Promise<EvolinkTask> {
    const url = `${this.baseUrl}/tasks/${taskId}`;
    let res;
    try {
      res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.pollTimeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw classify(0, 'NETWORK', `GET /tasks/${taskId} network error: ${(err as Error).message}`);
    }
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw classify(res.statusCode, `HTTP_${res.statusCode}`, text.slice(0, 500));
    }
    return safeParse<EvolinkTask>(`GET /tasks/${taskId}`, text);
  }

  /**
   * Download a result asset. Evolink returns presigned TOS URLs that already
   * carry their own signature — sending our Bearer token can make TOS reject
   * the request, so we fetch these clean.
   */
  async fetchAsset(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    // BL-5: SSRF guard — refuse private/loopback/link-local targets before any
    // socket, and pin a rebinding-safe dispatcher for the fetch itself.
    const res = await guardedRequest(url, {
      method: 'GET',
      signal: AbortSignal.timeout(120_000), // videos can be several MB
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
