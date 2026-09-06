// Helpers every gateway adapter needs, and every gateway adapter had its own
// copy of. They were byte-identical across kie / laozhang / atlascloud /
// openrouter / evolink / adapter — which is exactly how a retry policy drifts:
// fix the 429 rule in one adapter and four others keep the old one.
import { ProviderError } from './types';

/** Map a response Content-Type to the extension we store the asset under. */
export function extensionFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('mp4')) return 'mp4';
  if (ct.includes('webm')) return 'webm';
  return 'bin';
}

/** Read `key` off a loose params bag as a list of non-empty URL strings. */
export function urlArr(p: Record<string, unknown>, key: string): string[] {
  const v = p[key];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
}

/**
 * The single retry rule for provider failures: transport error (0), timeout
 * (408), rate limit (429) and every 5xx are worth retrying; a 4xx is our bug or
 * the user's input and never is.
 */
export function classifyProviderError(
  status: number,
  code: string,
  message: string,
): ProviderError {
  const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  return new ProviderError({ code, status, retryable, message });
}
