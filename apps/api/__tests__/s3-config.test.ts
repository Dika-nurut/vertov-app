import { describe, expect, it } from 'vitest';
import {
  resolveS3ClientOptions,
  anonymousBucketPolicyEnabled,
  parseEndpoint,
  tempPartKey,
  tempUploadPrefix,
  TEMP_UPLOAD_PREFIX,
} from '../src/s3-config';

// Pure config test — no live bucket. Guards PORT-2 (managed-S3 v4 signing region)
// and PORT-3 (private bucket on managed S3 vs. anonymous-read on local MinIO).

describe('resolveS3ClientOptions (PORT-2)', () => {
  it('threads S3_REGION into the client (managed S3 signs with its region)', () => {
    const opts = resolveS3ClientOptions({
      MINIO_ENDPOINT: 'https://storage.yandexcloud.net',
      MINIO_ROOT_USER: 'key',
      MINIO_ROOT_PASSWORD: 'secret',
      S3_REGION: 'ru-central1',
    });
    expect(opts.region).toBe('ru-central1');
    expect(opts).toMatchObject({
      endPoint: 'storage.yandexcloud.net',
      port: 443,
      useSSL: true,
      accessKey: 'key',
      secretKey: 'secret',
    });
  });

  it('S3_REGION wins over the legacy MINIO_REGION, else defaults to us-east-1', () => {
    expect(
      resolveS3ClientOptions({ S3_REGION: 'ru-central1', MINIO_REGION: 'us-east-1' }).region,
    ).toBe('ru-central1');
    expect(resolveS3ClientOptions({ MINIO_REGION: 'ru-central1a' }).region).toBe('ru-central1a');
    expect(resolveS3ClientOptions({}).region).toBe('us-east-1');
  });

  it('parses a plain-http local MinIO endpoint with its port', () => {
    expect(parseEndpoint('http://127.0.0.1:9000')).toEqual({
      endPoint: '127.0.0.1',
      port: 9000,
      useSSL: false,
    });
  });
});

describe('temp upload keys (INF-8 lifecycle sweep)', () => {
  it('places every chunk under the single TEMP_UPLOAD_PREFIX so one lifecycle rule sweeps all', () => {
    expect(TEMP_UPLOAD_PREFIX).toBe('_mp/');
    expect(tempPartKey('user-123', 'abc', 7).startsWith('_mp/')).toBe(true);
    expect(tempUploadPrefix('user-123', 'abc').startsWith('_mp/')).toBe(true);
  });

  it('keeps the session userId in the key (per-user scoping preserved)', () => {
    expect(tempPartKey('user-123', 'abc', 7)).toBe('_mp/user-123/abc/00007');
    expect(tempUploadPrefix('user-123', 'abc')).toBe('_mp/user-123/abc/');
  });

  it('zero-pads the index so lexical listing matches numeric order', () => {
    expect(tempPartKey('u', 'id', 0).endsWith('/00000')).toBe(true);
    expect(tempPartKey('u', 'id', 42).endsWith('/00042')).toBe(true);
  });
});

describe('anonymousBucketPolicyEnabled (PORT-3)', () => {
  it('defaults to true (local MinIO public read)', () => {
    expect(anonymousBucketPolicyEnabled({})).toBe(true);
  });

  it('is false on managed S3 (bucket stays private, served via CDN)', () => {
    expect(anonymousBucketPolicyEnabled({ S3_ANONYMOUS_BUCKET_POLICY: 'false' })).toBe(false);
    expect(anonymousBucketPolicyEnabled({ S3_ANONYMOUS_BUCKET_POLICY: 'FALSE' })).toBe(false);
  });
});
