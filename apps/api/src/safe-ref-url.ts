import { isIP } from 'node:net';

/**
 * SF-8 — generation reference URL fields are forwarded to the
 * provider verbatim (params is `z.record(z.unknown())`). A crafted POST could
 * point them at `http://169.254.169.254/…`, `127.0.0.1`, or an internal host.
 *
 * This is a fast, synchronous API-boundary check (no DNS): it refuses a
 * non-http(s) scheme or a literal private/loopback/link-local/CGNAT/multicast
 * IP before the URL is ever persisted or forwarded. Own-origin asset URLs are
 * always allowed. An external *public* reference (a legitimate use) still
 * passes here, but the API's own dimension probe deliberately does not fetch
 * it; each provider adapter remains responsible for its own egress policy.
 */

/** The array param keys that carry user-supplied reference media URLs. */
export const REFERENCE_URL_PARAM_KEYS = ['imageUrls', 'videoUrls', 'audioUrls'] as const;

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map((s) => Number(s));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true; // multicast/reserved/broadcast
  return false;
}

function isPrivateV6(ip: string): boolean {
  const n = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const embedded = n.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded && embedded[1]) return isPrivateV4(embedded[1]);
  if (n === '::1' || n === '::') return true;
  if (/^fe[89ab][0-9a-f]/.test(n)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}/.test(n)) return true; // unique-local
  if (/^ff[0-9a-f]{2}/.test(n)) return true; // multicast
  return false;
}

/**
 * True when `url` is safe to forward as a reference: an own-origin asset, or an
 * http(s) URL whose literal host (if any) is not in a private/internal range.
 */
export function isSafeReferenceUrl(url: string, allowedOrigins: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // Compare parsed origins, never raw prefixes: otherwise an allowed internal
  // origin such as `http://127.0.0.1:9000` would bless
  // `http://127.0.0.1:9000@169.254.169.254/...` before the literal-host guard
  // sees the metadata address.
  if (
    allowedOrigins.some((rawOrigin) => {
      if (!rawOrigin) return false;
      try {
        return u.origin === new URL(rawOrigin).origin;
      } catch {
        return false;
      }
    })
  )
    return true;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const fam = isIP(host);
  if (fam === 4) return !isPrivateV4(host);
  if (fam === 6) return !isPrivateV6(host);
  return true; // a hostname (external public reference) — provider fetch policy applies
}

/**
 * Scan `referenceAssets` + the known URL-bearing param arrays and return the
 * first unsafe URL, or null when all are safe.
 */
export function firstUnsafeReferenceUrl(
  params: Record<string, unknown> | null | undefined,
  referenceAssets: readonly string[],
  allowedOrigins: readonly string[],
): string | null {
  const urls: string[] = [...referenceAssets];
  if (params) {
    for (const key of REFERENCE_URL_PARAM_KEYS) {
      const v = params[key];
      if (Array.isArray(v)) {
        for (const item of v) if (typeof item === 'string') urls.push(item);
      }
    }
    const frames = params['frameImages'];
    if (Array.isArray(frames)) {
      for (const frame of frames) {
        if (frame && typeof frame === 'object' && 'url' in frame && typeof frame.url === 'string') {
          urls.push(frame.url);
        }
      }
    }
  }
  for (const url of urls) {
    if (!isSafeReferenceUrl(url, allowedOrigins)) return url;
  }
  return null;
}

/** Build the own-origin allow-list from the asset/API env origins. */
export function referenceAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.ASSET_PUBLIC_URL, env.API_PUBLIC_URL, env.MINIO_PUBLIC_URL, env.MINIO_ENDPOINT]
    .map((o) => o?.replace(/\/$/, ''))
    .filter((o): o is string => Boolean(o));
}
