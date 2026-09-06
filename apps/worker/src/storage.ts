import { Client as MinioClient } from 'minio';

export interface AssetUploadInput {
  userId: string;
  jobId: string;
  index: number;
  bytes: Buffer;
  contentType: string;
  extension: string;
}

export interface UploadedAsset {
  key: string;
  url: string;
}

function parseEndpoint(raw: string): { endPoint: string; port: number; useSSL: boolean } {
  const u = new URL(raw);
  const useSSL = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : useSSL ? 443 : 80;
  return { endPoint: u.hostname, port, useSSL };
}

/**
 * Whether to grant the asset bucket anonymous public-read. Defaults to true
 * (local MinIO + the legacy single-host prod, where the browser fetches assets
 * directly). Set S3_ANONYMOUS_BUCKET_POLICY=false on managed S3 so the bucket
 * stays private and the CDN/edge serves it with origin credentials (PORT-3).
 */
export function anonymousBucketPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.S3_ANONYMOUS_BUCKET_POLICY ?? 'true').toLowerCase() !== 'false';
}

export class AssetStorage {
  private readonly client: MinioClient;
  private readonly bucket: string;
  private readonly publicBase: string;
  private readonly anonymousReadPolicy: boolean;
  private bucketReady: Promise<void> | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const endpoint = env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000';
    const { endPoint, port, useSSL } = parseEndpoint(endpoint);
    this.client = new MinioClient({
      endPoint,
      port,
      useSSL,
      accessKey: env.MINIO_ROOT_USER ?? 'seedminio',
      secretKey: env.MINIO_ROOT_PASSWORD ?? 'CHANGE_ME_HEX24',
      // Managed S3 (Yandex Object Storage) signs v4 with the bucket's region;
      // a wrong region → SignatureDoesNotMatch. S3_REGION is the canonical knob
      // (MINIO_REGION kept as a fallback for older configs).
      region: env.S3_REGION ?? env.MINIO_REGION ?? 'us-east-1',
    });
    this.bucket = env.MINIO_BUCKET ?? 'seed-assets';
    // Whether to grant the bucket anonymous public read. True for local MinIO
    // (the browser loads assets by URL). On managed S3 the bucket stays PRIVATE
    // and the CDN/edge pulls with credentials (PORT-3): set
    // S3_ANONYMOUS_BUCKET_POLICY=false so the boot policy-set is skipped.
    this.anonymousReadPolicy = anonymousBucketPolicyEnabled(env);
    // ASSET_PUBLIC_URL is the BROWSER-reachable origin (the API, which
    // proxies /<bucket>/* to MinIO). MINIO_PUBLIC_URL kept as fallback for
    // older configs, but it usually points at 127.0.0.1:9000 — fine for
    // server-side fetches, dead for real users' browsers.
    this.publicBase = (env.ASSET_PUBLIC_URL ?? env.MINIO_PUBLIC_URL ?? endpoint).replace(/\/$/, '');
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return this.bucketReady;
    this.bucketReady = (async () => {
      const exists = await this.client.bucketExists(this.bucket).catch(() => false);
      if (!exists) await this.client.makeBucket(this.bucket, 'us-east-1');
      // Local MinIO: anonymous read so the web client renders assets directly by
      // URL. On managed S3 the bucket stays private (CDN serves it with origin
      // credentials) — anonymousReadPolicy is false there, so this is a no-op.
      if (this.anonymousReadPolicy) {
        const policy = JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${this.bucket}/*`],
            },
          ],
        });
        await this.client.setBucketPolicy(this.bucket, policy).catch(() => {});
      }
    })();
    try {
      await this.bucketReady;
    } catch (err) {
      // Don't permanently poison the cache — let the next put() retry.
      this.bucketReady = null;
      throw err;
    }
    return this.bucketReady;
  }

  async put(input: AssetUploadInput): Promise<UploadedAsset> {
    await this.ensureBucket();
    const key = `${input.userId}/${input.jobId}/${input.index}.${input.extension}`;
    await this.client.putObject(this.bucket, key, input.bytes, input.bytes.length, {
      'Content-Type': input.contentType,
    });
    return { key, url: `${this.publicBase}/${this.bucket}/${key}` };
  }

  /**
   * Parse the MinIO object key out of a public asset URL we minted.
   * Returns null when the URL doesn't belong to our bucket (so the
   * gallery reaper can skip foreign URLs without deleting random data).
   */
  keyFromUrl(url: string): string | null {
    const prefix = `${this.publicBase}/${this.bucket}/`;
    if (!url.startsWith(prefix)) return null;
    return url.slice(prefix.length);
  }

  /**
   * Delete a batch of objects. MinIO resolves `removeObjects` with one result
   * per server-reported failure instead of rejecting, so surface those errors
   * to the caller as well; erasure workers must retain their retry pointer when
   * even one object in a batch was not removed.
   */
  async removeObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.ensureBucket();
    const responses = await this.client.removeObjects(this.bucket, keys);
    const failures = responses.filter((response) => response?.Error);
    if (failures.length > 0) {
      const summary = failures
        .slice(0, 3)
        .map((response) => {
          const error = response?.Error;
          return `${error?.Key ?? 'unknown'}:${error?.Code ?? 'unknown'}`;
        })
        .join(', ');
      throw new Error(
        `asset storage removeObjects failed for ${failures.length} object(s): ${summary}`,
      );
    }
  }

  /**
   * List object keys under an owned prefix. The account-erasure reaper uses
   * this for Studio source uploads and temporary multipart chunks, which have
   * no gallery row to point at. Prefixes are supplied by the caller from a
   * trusted user id; this method never accepts a bucket name or URL.
   */
  async listKeys(prefix: string): Promise<string[]> {
    await this.ensureBucket();
    return new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.client.listObjectsV2(this.bucket, prefix, true);
      stream.on('data', (object) => {
        if (object.name) keys.push(object.name);
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }
}
