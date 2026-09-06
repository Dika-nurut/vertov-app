/**
 * BL-9 — public read endpoints shared the global 100/min/IP bucket with
 * everything else, so a single media-heavy page (a showcase grid fans out many
 * asset-proxy requests) could exhaust a real user's budget, while IP-rotating
 * scrapers were undefended.
 *
 * `@fastify/rate-limit` gives each route with its own `config.rateLimit` an
 * INDEPENDENT per-IP bucket (verified: bursting a route with a higher route-max
 * does not increment the global counter). So we hand the public read surfaces
 * their own, appropriately-sized buckets:
 *  - the asset proxy gets a generous bucket (a first page load legitimately
 *    fans out many byte requests — until a CDN fronts it, BL-10);
 *  - the JSON feeds (showcase / `/g/:slug` / preset-packs / models) get a
 *    separate moderate bucket so scraping is bounded without starving — or
 *    being starved by — the global mutating-route budget.
 *
 * Non-prod lifts the caps so dev/e2e (browser + SSR + Playwright share one IP)
 * never trips them.
 */
const prod = (isProd?: boolean): boolean => isProd ?? process.env.NODE_ENV === 'production';

const LIFTED = 10_000;
const ASSET_PROXY_MAX = 600; // per IP / minute
const PUBLIC_FEED_MAX = 240; // per IP / minute
const PUBLIC_REPORT_MAX = 20; // report submissions are rare; bound audit-log amplification

/** Per-route config for the public asset proxy (`/<bucket>/*`). */
export function assetProxyRateLimit(isProd?: boolean): {
  rateLimit: { max: number; timeWindow: string };
} {
  return { rateLimit: { max: prod(isProd) ? ASSET_PROXY_MAX : LIFTED, timeWindow: '1 minute' } };
}

/** Per-route config for public JSON read feeds. */
export function publicFeedRateLimit(isProd?: boolean): {
  rateLimit: { max: number; timeWindow: string };
} {
  return { rateLimit: { max: prod(isProd) ? PUBLIC_FEED_MAX : LIFTED, timeWindow: '1 minute' } };
}

/** Per-IP config for public abuse-report submissions, separate from read feeds. */
export function publicReportRateLimit(isProd?: boolean): {
  rateLimit: { max: number; timeWindow: string };
} {
  return { rateLimit: { max: prod(isProd) ? PUBLIC_REPORT_MAX : LIFTED, timeWindow: '1 minute' } };
}

export const PUBLIC_RATE_LIMITS = { ASSET_PROXY_MAX, PUBLIC_FEED_MAX, PUBLIC_REPORT_MAX } as const;
