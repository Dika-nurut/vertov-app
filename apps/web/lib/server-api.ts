import { isIP } from 'node:net';
import { cookies, headers } from 'next/headers';

interface HeaderReader {
  get(name: string): string | null;
}

/**
 * The web server is a trusted SSR hop. Forward only the first validated client
 * address, rather than the whole inbound chain, so the API's trusted-proxy
 * resolver keys welcome velocity on the browser and not the web container.
 */
export function forwardedClientIp(incoming: HeaderReader): string | null {
  const forwarded = incoming.get('x-forwarded-for');
  const realIp = incoming.get('x-real-ip');
  const candidate = forwarded?.split(',')[0]?.trim() || realIp?.trim() || null;
  if (!candidate) return null;
  // Avoid forwarding arbitrary header text into the API's proxy chain.
  return isIP(candidate) ? candidate : null;
}

// SSR runs INSIDE the cluster: fetch the API directly over the internal network
// (`API_INTERNAL_URL`, e.g. http://api:4000) so a server render never has to hairpin
// out to the public edge (which deadlocks the web↔edge healthcheck and is blocked by
// NAT reflection on most clouds). `API_INTERNAL_URL` has NO NEXT_PUBLIC_ prefix, so
// it's read at RUNTIME on the server (not inlined at build). Falls back to the public
// URL for single-origin/dev setups.
const API_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
// Handed to CLIENT components — must be the browser-reachable public origin.
const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const FETCH_TIMEOUT_MS = Number(process.env.SERVER_API_TIMEOUT_MS ?? 8000);

async function cookieHeader(): Promise<string> {
  const store = await cookies();
  return store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Server-side fetch helper for Server Components. Wraps every call in:
 *   1. AbortController so a stuck API can't hang the render forever (#19).
 *   2. try/catch around fetch + res.json() so an HTML error page from a
 *      misbehaving upstream doesn't crash the page (#6); the caller gets
 *      `{ status, data: null }` and renders its own fallback.
 */
async function apiFetch<T>(
  path: string,
  init: RequestInit,
): Promise<{ status: number; data: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const outgoingHeaders = new Headers(init.headers);
    outgoingHeaders.set('cookie', await cookieHeader());
    const clientIp = forwardedClientIp(await headers());
    if (clientIp) outgoingHeaders.set('x-forwarded-for', clientIp);
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: outgoingHeaders,
      cache: 'no-store',
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { status: res.status, data: null };
    }
    try {
      const data = (await res.json()) as T;
      // Preserve structured API errors (notably the corrupt-board recovery
      // envelope) so the server component can render a path forward. Auth and
      // missing-resource responses still intentionally become null data.
      if (res.status === 401 || res.status === 404) return { status: res.status, data: null };
      return { status: res.status, data };
    } catch {
      return { status: res.status, data: null };
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 504, data: null };
    }
    return { status: 502, data: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function apiGet<T>(path: string): Promise<{ status: number; data: T | null }> {
  return apiFetch<T>(path, {});
}

/** Pre-paywall skip-list-when-empty pages (boards/scenario/studio) create the
 * first item server-side before redirecting — same shape as apiGet, POST. */
export async function apiPost<T>(
  path: string,
  body: unknown,
): Promise<{ status: number; data: T | null }> {
  return apiFetch<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function apiBaseUrl(): string {
  return PUBLIC_API_URL;
}
