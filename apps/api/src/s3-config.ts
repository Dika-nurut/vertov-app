// Dependency-free S3/MinIO config resolution, shared by the studio routes (and
// unit-testable without a live bucket). Keeps the managed-cloud migration
// config-only: PORT-2 (v4 signing region) and PORT-3 (private bucket on managed
// S3 vs. anonymous-read on local MinIO).

export interface S3ClientOptions {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
}

export function parseEndpoint(raw: string): { endPoint: string; port: number; useSSL: boolean } {
  const u = new URL(raw);
  const useSSL = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : useSSL ? 443 : 80;
  return { endPoint: u.hostname, port, useSSL };
}

/**
 * Build the MinIO/S3 client options from env. S3_REGION is the canonical knob —
 * managed S3 (Yandex Object Storage) signs v4 with the bucket's region, and a
 * wrong region yields SignatureDoesNotMatch. MINIO_REGION is kept as a fallback
 * for older configs; both default to us-east-1 for local MinIO.
 */
export function resolveS3ClientOptions(env: NodeJS.ProcessEnv = process.env): S3ClientOptions {
  const endpoint = env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000';
  const { endPoint, port, useSSL } = parseEndpoint(endpoint);
  return {
    endPoint,
    port,
    useSSL,
    accessKey: env.MINIO_ROOT_USER ?? 'seedminio',
    secretKey: env.MINIO_ROOT_PASSWORD ?? '',
    region: env.S3_REGION ?? env.MINIO_REGION ?? 'us-east-1',
  };
}

/**
 * Whether to grant the asset bucket anonymous public-read. Defaults to true
 * (local MinIO + legacy single-host prod, where the browser fetches assets
 * directly). Set S3_ANONYMOUS_BUCKET_POLICY=false on managed S3 so the bucket
 * stays private and the CDN/edge serves it with origin credentials (PORT-3);
 * the boot policy-set then becomes a no-op rather than a refused/erroring call.
 */
export function anonymousBucketPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.S3_ANONYMOUS_BUCKET_POLICY ?? 'true').toLowerCase() !== 'false';
}

// ── Resumable-upload temp chunks ────────────────────────────────────────────
// Chunks for an in-flight multipart upload are written under a single top-level
// prefix so an S3 lifecycle rule on `TEMP_UPLOAD_PREFIX` can sweep abandoned
// uploads bucket-wide (the complete/abort paths delete them on the happy path,
// but a dropped client leaves multi-GB chunks behind — a real cost leak at
// scale). The userId still comes from the session and stays IN the key, so the
// per-user scoping ("a user can only touch their own upload") is unchanged.
// Final assets keep their `${userId}/…` prefix (public serving + gallery reaper).
export const TEMP_UPLOAD_PREFIX = '_mp/';

export const tempPartKey = (userId: string, uploadId: string, index: number): string =>
  `${TEMP_UPLOAD_PREFIX}${userId}/${uploadId}/${String(index).padStart(5, '0')}`;

export const tempUploadPrefix = (userId: string, uploadId: string): string =>
  `${TEMP_UPLOAD_PREFIX}${userId}/${uploadId}/`;
