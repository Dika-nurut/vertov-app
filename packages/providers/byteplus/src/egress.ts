import { ProxyAgent, type Dispatcher } from 'undici';

/**
 * Egress forward-proxy dispatcher (business + technical rationale in
 * `docs/ops/egress-gateway.md`).
 *
 * WHY: every provider in this package is an international AI vendor, and several
 * of them (OpenRouter, AtlasCloud — both Cloudflare-fronted) block the RU cloud
 * VM's datacenter IP outright (`403 Access denied by security policy` /
 * Cloudflare interstitial naming the exact IP). The identical request/key from
 * a non-datacenter IP returns 200. So the fix is a network-transport one: route
 * this package's outbound calls through a forward proxy on a box whose IP is not
 * blocked. Nothing about the request changes except its source IP — same host,
 * same bearer key, TLS still end-to-end to the vendor (the proxy only CONNECT-
 * tunnels encrypted bytes). That keeps it clean under 152-ФЗ: a pure transit hop
 * in front of an already-inventoried cross-border processor, no new data store.
 *
 * HOW: when `EGRESS_PROXY_URL` is set, this returns a shared undici `ProxyAgent`
 * that every vendor client passes as its `dispatcher`. Unset → returns
 * `undefined`, i.e. undici's global dispatcher, i.e. today's exact behavior
 * (dev/CI/local untouched, all existing tests unchanged). RU-resident services
 * (Postgres, Redis, Object Storage, ЮKassa) live in other packages and never
 * touch this dispatcher, so they always stay direct — the proxy is scoped to
 * international AI egress only, never RU personal-data paths.
 *
 * `EGRESS_PROXY_TOKEN` (optional) is the full `Proxy-Authorization` header value
 * (e.g. `Basic <base64 user:pass>`) — defense-in-depth so the proxy is not an
 * open relay even if its firewall allow-list is ever misconfigured.
 */

let cached: { key: string; agent: ProxyAgent } | null = null;

export function egressDispatcher(env: NodeJS.ProcessEnv = process.env): Dispatcher | undefined {
  const uri = env.EGRESS_PROXY_URL?.trim();
  if (!uri) return undefined;
  const token = env.EGRESS_PROXY_TOKEN?.trim() || undefined;
  const key = `${uri}|${token ?? ''}`;
  if (cached && cached.key === key) return cached.agent;
  const agent = new ProxyAgent(token ? { uri, token } : { uri });
  cached = { key, agent };
  return agent;
}

/** Test-only: drop the memoized agent so a changed env is re-read. */
export function resetEgressDispatcherForTest(): void {
  cached = null;
}
