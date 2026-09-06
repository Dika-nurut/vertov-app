import { describe, expect, it, vi } from 'vitest';
import { AssetStorage, anonymousBucketPolicyEnabled } from './storage';

// Pure config test — no live S3. Guards PORT-2 (managed-S3 v4 signing needs the
// right region) and PORT-3 (managed-S3 buckets stay private; the anonymous-read
// policy is local-MinIO only).

const base = {
  MINIO_ENDPOINT: 'http://127.0.0.1:9000',
  MINIO_ROOT_USER: 'k',
  MINIO_ROOT_PASSWORD: 's',
};

const regionOf = (env: NodeJS.ProcessEnv): unknown =>
  (new AssetStorage(env) as unknown as { client: { region?: string } }).client.region;

describe('AssetStorage region (PORT-2)', () => {
  it('uses S3_REGION when set (managed S3 signs with its region)', () => {
    expect(regionOf({ ...base, S3_REGION: 'ru-central1' })).toBe('ru-central1');
  });

  it('S3_REGION takes precedence over the legacy MINIO_REGION', () => {
    expect(regionOf({ ...base, S3_REGION: 'ru-central1', MINIO_REGION: 'us-east-1' })).toBe(
      'ru-central1',
    );
  });

  it('falls back to MINIO_REGION, then us-east-1 for local MinIO', () => {
    expect(regionOf({ ...base, MINIO_REGION: 'ru-central1a' })).toBe('ru-central1a');
    expect(regionOf({ ...base })).toBe('us-east-1');
  });
});

describe('anonymousBucketPolicyEnabled (PORT-3)', () => {
  it('defaults to true (local MinIO public read)', () => {
    expect(anonymousBucketPolicyEnabled({})).toBe(true);
    expect(anonymousBucketPolicyEnabled({ S3_ANONYMOUS_BUCKET_POLICY: 'true' })).toBe(true);
  });

  it('is false on managed S3 (bucket stays private, served via CDN)', () => {
    expect(anonymousBucketPolicyEnabled({ S3_ANONYMOUS_BUCKET_POLICY: 'false' })).toBe(false);
    expect(anonymousBucketPolicyEnabled({ S3_ANONYMOUS_BUCKET_POLICY: 'FALSE' })).toBe(false);
  });
});

describe('AssetStorage.removeObjects', () => {
  function storageWithClient() {
    const storage = new AssetStorage({
      ...base,
      S3_ANONYMOUS_BUCKET_POLICY: 'false',
    });
    const client = {
      bucketExists: vi.fn().mockResolvedValue(true),
      removeObjects: vi.fn(),
    };
    (storage as unknown as { client: typeof client }).client = client;
    return { storage, client };
  }

  it('turns per-object MinIO delete errors into a retryable rejection', async () => {
    const { storage, client } = storageWithClient();
    client.removeObjects.mockResolvedValue([
      null,
      { Error: { Key: 'user/source.mp4', Code: 'AccessDenied' } },
    ]);

    await expect(storage.removeObjects(['user/source.mp4', 'user/sidecar.json'])).rejects.toThrow(
      /failed for 1 object\(s\).*AccessDenied/,
    );
  });

  it('resolves when MinIO reports no per-object errors', async () => {
    const { storage, client } = storageWithClient();
    client.removeObjects.mockResolvedValue([null, undefined]);

    await expect(storage.removeObjects(['user/source.mp4'])).resolves.toBeUndefined();
  });
});
