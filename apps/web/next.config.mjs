import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Honour a DIST_DIR override so an isolated PROD-build e2e floor can `next
  // build`/`next start` into a separate dir (e.g. `.next-floor`) WITHOUT
  // clobbering the live dev server's `.next` (the shared-stack build gotcha).
  // Unset → the default `.next`, so dev/CI are unchanged.
  distDir: process.env.DIST_DIR || '.next',
  // @seed/shared ships TS source (no build step) — Next must transpile it. Only
  // the pure, import-free preset-merge submodule is consumed (client submit seam).
  transpilePackages: ['@seed/shared'],
  // NOTE: do NOT set output:'standalone' — the web Dockerfile runs `next start`
  // against the full .next build it copies, and `next start` refuses to serve a
  // standalone build (container comes up "Ready" but never binds → healthcheck
  // fails). Standalone would need a different entrypoint (node server.js) +
  // copying .next/static & public; not worth it here.
  // instrumentation.ts is available by default in Next 15; no flag needed.
  typedRoutes: false,
  // Plausible proxy rewrites — routes /plausible/* through Next.js so
  // AdBlock lists that block plausible.io directly can't intercept them.
  async rewrites() {
    const rewrites = [
      {
        source: '/plausible/script.js',
        destination: 'https://plausible.io/js/script.js',
      },
      {
        source: '/plausible/event',
        destination: 'https://plausible.io/api/event',
      },
    ];
    // Same-origin asset-bucket paths are normally proxied to MinIO by Caddy in
    // front of this app (docker/Caddyfile @assets). On bare `next start`
    // previews there is no Caddy, so an explicit upstream makes the buckets
    // resolve there too. Unset in prod → no rewrite, Caddy keeps owning it.
    const assetUpstream = process.env.ASSET_PROXY_UPSTREAM;
    if (assetUpstream) {
      for (const bucket of ['seed-assets', 'seed-preset-previews', 'seed-demo-assets']) {
        rewrites.push({
          source: `/${bucket}/:path*`,
          destination: `${assetUpstream}/${bucket}/:path*`,
        });
      }
    }
    return rewrites;
  },
};

// withSentryConfig wraps the build to upload source maps to Sentry when
// SENTRY_AUTH_TOKEN is present. silent:true prevents build failures when the
// token is absent (e.g. local dev, CI without creds). authToken:undefined is
// safe — Sentry CLI skips the upload step and the build succeeds as normal.
export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG ?? '',
  project: process.env.SENTRY_PROJECT ?? '',
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Disable automatic release creation on CI without a token.
  webpack: { treeshake: { removeDebugLogging: true } },
  hideSourceMaps: true,
});
