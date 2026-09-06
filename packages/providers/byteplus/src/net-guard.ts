import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupOptions } from 'node:dns';
import { Agent, type Dispatcher, MockAgent, getGlobalDispatcher, request } from 'undici';
import { ProviderError } from './types';

/**
 * BL-5 — SSRF guard for asset downloads.
 *
 * `fetchAsset` pulls provider-returned URLs straight into the worker. A
 * malicious or compromised provider response (or a user-influenced reference
 * URL) could point at `http://169.254.169.254/…`, `127.0.0.1`, or an internal
 * service and turn the worker into an SSRF/egress proxy. Size caps and timeouts
 * existed; an address allow-policy did not.
 *
 * Two layers, both fail-closed:
 *  1. `assertUrlPublic(url)` — runs BEFORE any socket: rejects non-http(s)
 *     schemes and any host (literal IP or resolved hostname) in a private /
 *     loopback / link-local / unique-local / CGNAT / multicast range.
 *  2. `guardedRequest(url, …)` — fetches through an undici Agent whose
 *     `connect.lookup` re-validates the resolved address at connect time, so a
 *     DNS-rebinding answer that flips to a private IP after step 1 is still
 *     refused at the socket.
 */
export class SsrfError extends ProviderError {
  constructor(message: string) {
    super({ code: 'SSRF_BLOCKED', status: 400, retryable: false, message });
    this.name = 'SsrfError';
  }
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split('.').map((s) => Number(s));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, 255.255.255.255
  return false;
}

function isBlockedV6(ip: string): boolean {
  const norm = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped / -compatible (::ffff:a.b.c.d / ::a.b.c.d) → judge the embedded v4.
  const embedded = norm.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded && embedded[1]) return isBlockedV4(embedded[1]);
  if (norm === '::1') return true; // loopback
  if (norm === '::') return true; // unspecified
  // link-local fe80::/10 → first hextet fe80..febf
  if (/^fe[89ab][0-9a-f]/.test(norm)) return true;
  // unique-local fc00::/7
  if (/^f[cd][0-9a-f]{2}/.test(norm)) return true;
  // multicast ff00::/8
  if (/^ff[0-9a-f]{2}/.test(norm)) return true;
  return false;
}

/** True when an IP literal falls in a blocked (non-public) range. */
export function isBlockedIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, '');
  const fam = isIP(host);
  if (fam === 4) return isBlockedV4(host);
  if (fam === 6) return isBlockedV6(host);
  return true; // not a valid IP literal → fail closed
}

function dnsLookupAll(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * Throw (before any socket) when `url` is not safe to fetch: a non-http(s)
 * scheme, an unparsable URL, or a host that is — or resolves to — a blocked
 * address range.
 */
export async function assertUrlPublic(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError(`invalid asset URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`blocked URL scheme ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`blocked address ${host}`);
    return;
  }
  let addrs: string[];
  try {
    addrs = await dnsLookupAll(host);
  } catch {
    // An unresolvable host is not an SSRF target (it points at nothing); let
    // the request itself fail naturally. A real internal target DOES resolve —
    // to a private range — and is caught below (and again at connect time by
    // the rebinding-safe dispatcher in `guardedRequest`).
    return;
  }
  for (const a of addrs) {
    if (isBlockedIp(a)) throw new SsrfError(`${host} resolved to blocked address ${a}`);
  }
}

/**
 * undici `connect.lookup` that re-validates EVERY resolved address at connect
 * time (DNS-rebinding-safe) and refuses the connection if any is blocked.
 */
export function safeLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
): void {
  const opts = typeof options === 'object' && options !== null ? options : {};
  dnsLookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    for (const a of addresses) {
      if (isBlockedIp(a.address)) {
        return callback(new SsrfError(`${hostname} → blocked address ${a.address}`), '', 0);
      }
    }
    const chosen = addresses[0];
    if (!chosen) return callback(new SsrfError(`no address for ${hostname}`), '', 0);
    if (opts.all) return callback(null, addresses);
    callback(null, chosen.address, chosen.family);
  });
}

// One shared agent; the lookup hook does the per-connect validation.
const ssrfSafeAgent = new Agent({ connect: { lookup: safeLookup } });

/**
 * Drop-in replacement for undici `request` that fails closed on SSRF: it
 * asserts the URL is public before connecting, then fetches through the
 * rebinding-safe agent in production. An explicitly-provided dispatcher wins,
 * and an installed `MockAgent` (tests) is honoured so the network can be
 * stubbed — neither path can be a real internal target.
 */
export function guardedRequest(
  url: string,
  options: Parameters<typeof request>[1],
): ReturnType<typeof request> {
  return assertUrlPublic(url).then(() => {
    const provided = (options as { dispatcher?: Dispatcher } | undefined)?.dispatcher;
    const global = getGlobalDispatcher();
    const dispatcher = provided ?? (global instanceof MockAgent ? global : ssrfSafeAgent);
    return request(url, { ...(options ?? {}), dispatcher });
  });
}
