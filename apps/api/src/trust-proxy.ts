/**
 * BL-7 — derive the real client IP behind the reverse proxy.
 *
 * The API binds to loopback and sits behind Caddy (← cloudflared). Without a
 * `trustProxy` setting Fastify uses the socket peer — always the local proxy —
 * so every per-IP rate limit (global 100/min, magic-link 5/15min, the per-IP
 * abuse ceilings) buckets ALL users together. Set it to `true` and the limits
 * flip the other way: a client can spoof `X-Forwarded-For` and dodge them.
 *
 * The fail-safe default trusts ONLY the loopback hop (the local Caddy). Then
 * `proxy-addr` walks `X-Forwarded-For` from the right and returns the first
 * address that isn't a trusted hop — the real client when the request truly
 * came through the local proxy, and the socket peer (ignoring any spoofed XFF)
 * for a direct, untrusted connection.
 *
 * `TRUST_PROXY` overrides for other topologies:
 *   - unset / empty  → trust loopback only (`127.0.0.1`, `::1`) — the default
 *   - `false`        → trust nobody (`req.ip` is always the socket peer)
 *   - `true`         → trust every hop (ONLY behind a fully-controlled edge)
 *   - a number `N`   → trust the N hops nearest the server
 *   - a CIDR/IP list → trust exactly those addresses/subnets (comma-separated)
 */
export type TrustProxyValue = boolean | number | string[];

export function resolveTrustProxy(
  env: { TRUST_PROXY?: string } = process.env as { TRUST_PROXY?: string },
): TrustProxyValue {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return ['127.0.0.1', '::1'];
  if (raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
