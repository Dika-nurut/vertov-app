import { describe, expect, it } from 'vitest';
import { toInternalAssetUrl } from '../src/storyboard-asset-url';

const ENV = {
  ASSET_PUBLIC_URL: 'https://assets.example',
  API_PUBLIC_URL: 'https://api.example',
  MINIO_PUBLIC_URL: 'http://minio-public:9000',
  MINIO_ENDPOINT: 'http://minio-internal:9000',
  MINIO_BUCKET: 'seed-assets',
} as NodeJS.ProcessEnv;

describe('public storyboard asset URL boundary', () => {
  it('rewrites configured CDN/API asset paths to the internal bucket', () => {
    expect(toInternalAssetUrl('https://assets.example/seed-assets/user/frame.png', ENV)).toBe(
      'http://minio-internal:9000/seed-assets/user/frame.png',
    );
    expect(toInternalAssetUrl('https://api.example/seed-assets/user/frame.png', ENV)).toBe(
      'http://minio-internal:9000/seed-assets/user/frame.png',
    );
  });

  it('accepts a configured MinIO origin only inside the generated asset bucket', () => {
    expect(toInternalAssetUrl('http://minio-public:9000/seed-assets/user/frame.png', ENV)).toBe(
      'http://minio-internal:9000/seed-assets/user/frame.png',
    );
    expect(toInternalAssetUrl('http://minio-public:9000/minio/admin/v3/list', ENV)).toBeNull();
  });

  it.each([
    'https://attacker.example/seed-assets/frame.png',
    'https://assets.example.evil/seed-assets/frame.png',
    'http://127.0.0.1:4001/metrics',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'https://assets.example/seed-assets/../secrets',
  ])('fails closed for a non-owned or non-asset URL: %s', (url) => {
    expect(toInternalAssetUrl(url, ENV)).toBeNull();
  });

  it('supports an origin configured with the bucket path without duplicating it', () => {
    expect(
      toInternalAssetUrl('https://cdn.example/seed-assets/user/frame.png', {
        ...ENV,
        ASSET_PUBLIC_URL: 'https://cdn.example/seed-assets',
      }),
    ).toBe('http://minio-internal:9000/seed-assets/user/frame.png');
  });
});
