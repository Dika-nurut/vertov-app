import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BL-10 — no CDN: every asset byte was proxied through the Node API event loop
 * (the production `docker/Caddyfile` was a `respond 404` placeholder). The edge
 * config must front the object store for the public asset buckets so the API no
 * longer pipes those bytes. This source-scan guard fails on the old placeholder
 * and on any regression that drops asset edge-serving.
 */
const caddyfile = readFileSync(
  fileURLToPath(new URL('../../../docker/Caddyfile', import.meta.url)),
  'utf-8',
);
const productionCompose = readFileSync(
  fileURLToPath(new URL('../../../infra/compute/docker-compose.app.yml', import.meta.url)),
  'utf-8',
);

describe('BL-10: production Caddyfile serves public assets from the edge', () => {
  it('is no longer the bare 404 placeholder', () => {
    expect(caddyfile).toMatch(/reverse_proxy/);
    expect(caddyfile.trim()).not.toMatch(/^\S+\s*\{\s*respond\s+404\s*\}$/s);
  });

  it('isolates the dedicated asset hostname from application routes', () => {
    expect(caddyfile).toMatch(/assets\.vertov\.space\s*\{/);
    expect(caddyfile).toMatch(/@asset_host_media[\s\S]*reverse_proxy[\s\S]*respond\s+404/);
  });

  it('routes both public asset buckets at the edge', () => {
    expect(caddyfile).toMatch(/\/seed-assets\/\*/);
    expect(caddyfile).toMatch(/\/seed-preset-previews\/\*/);
  });

  it('reverse-proxies the asset buckets to MinIO (not the Node API)', () => {
    // The @assets matcher must proxy to a minio upstream, and the api upstream
    // must be a DIFFERENT handler — so asset bytes bypass the app.
    expect(caddyfile).toMatch(/@assets[\s\S]*reverse_proxy[\s\S]*minio/i);
    expect(caddyfile).toMatch(/reverse_proxy[^\n]*(seed-api|API_UPSTREAM|:4000)/);
  });

  it('keeps a long-lived cache-control on edge-served assets', () => {
    expect(caddyfile).toMatch(/Cache-Control[\s\S]*max-age=\d+/i);
  });

  it('fails closed when the production edge site address is missing', () => {
    expect(productionCompose).toMatch(/SEED_SITE_ADDRESS:\s*\$\{SEED_SITE_ADDRESS:\?[^}]+\}/);
    expect(productionCompose).not.toMatch(/SEED_SITE_ADDRESS:\s*\$\{SEED_SITE_ADDRESS:-:8080\}/);
  });

  it('passes the immutable deploy tag to the API readiness identity', () => {
    expect(productionCompose).toMatch(
      /SEED_COMMIT_SHA:\s*\$\{SEED_COMMIT_SHA:-\$\{SEED_IMAGE_TAG:-\}\}/,
    );
  });
});
