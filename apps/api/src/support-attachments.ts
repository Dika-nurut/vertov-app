import { Client as MinioClient } from 'minio';
import { nid } from '@seed/db';
import type { AuthEmailAttachment } from '@seed/credits';
import {
  SUPPORT_ATTACHMENT_BUCKET,
  SUPPORT_ATTACHMENT_PREFIX,
  SUPPORT_ATTACHMENT_RETENTION_DAYS,
  isSafeSupportAttachmentKey,
  type SupportAttachmentContentType,
} from '@seed/shared/support-attachments';
import { resolveS3ClientOptions } from './s3-config';

export interface SupportAttachmentUpload {
  filename: string;
  contentType: SupportAttachmentContentType;
  bytes: Buffer;
}

export interface SupportAttachmentStore {
  put(input: SupportAttachmentUpload & { requestId: string }): Promise<AuthEmailAttachment>;
  remove(objectKeys: string[]): Promise<void>;
}

interface SupportAttachmentLifecycle {
  Rule: Array<{
    ID: string;
    Status: string;
    Prefix: string;
    Expiration: { Days: number };
  }>;
}

export interface SupportAttachmentClient {
  bucketExists(bucketName: string): Promise<boolean>;
  makeBucket(bucketName: string, region: string): Promise<void>;
  setBucketLifecycle(bucketName: string, lifecycle: SupportAttachmentLifecycle): Promise<void>;
  putObject(
    bucketName: string,
    objectName: string,
    data: Buffer,
    size: number,
    metaData: Record<string, string>,
  ): Promise<unknown>;
  removeObject(bucketName: string, objectName: string): Promise<void>;
}

const LIFECYCLE: SupportAttachmentLifecycle = {
  Rule: [
    {
      ID: 'support-attachments-expire',
      Status: 'Enabled',
      Prefix: SUPPORT_ATTACHMENT_PREFIX,
      Expiration: { Days: SUPPORT_ATTACHMENT_RETENTION_DAYS },
    },
  ],
};

function assertSupportKey(objectKey: string): void {
  if (!isSafeSupportAttachmentKey(objectKey)) {
    throw new Error('invalid support attachment key');
  }
}

function bucketAlreadyExists(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return (
    candidate.code === 'BucketAlreadyOwnedByYou' ||
    candidate.code === 'BucketAlreadyExists' ||
    candidate.statusCode === 409 ||
    candidate.statusCode === '409'
  );
}

/**
 * Support files live in a private bucket and are addressed only by queue refs.
 * The API owns bucket setup; the worker only reads/deletes objects from it.
 */
export function createSupportAttachmentStore(
  env: NodeJS.ProcessEnv = process.env,
  clientOverride?: SupportAttachmentClient,
): SupportAttachmentStore {
  const options = resolveS3ClientOptions(env);
  const client = clientOverride ?? (new MinioClient(options) as unknown as SupportAttachmentClient);
  // Managed-S3 data roles should not need bucket-admin permissions. Production
  // provisions this bucket and lifecycle rule separately; local MinIO can
  // bootstrap them explicitly for a zero-config developer setup.
  const bootstrapBucket =
    env.SUPPORT_ATTACHMENT_BOOTSTRAP === 'true' ||
    (env.SUPPORT_ATTACHMENT_BOOTSTRAP === undefined && env.NODE_ENV !== 'production');
  let bucketReady: Promise<void> | null = null;

  async function ensureBucket(): Promise<void> {
    if (!bootstrapBucket) return;
    if (bucketReady) return bucketReady;
    bucketReady = (async () => {
      const exists = await client.bucketExists(SUPPORT_ATTACHMENT_BUCKET);
      if (!exists) {
        try {
          await client.makeBucket(SUPPORT_ATTACHMENT_BUCKET, options.region);
        } catch (error) {
          // Another API instance may have won the first-upload race.
          if (!bucketAlreadyExists(error)) throw error;
        }
      }
      // New S3 buckets are private by default. Do not mutate bucket policy from
      // the request path; managed deployments provision it out of band.
      await client.setBucketLifecycle(SUPPORT_ATTACHMENT_BUCKET, LIFECYCLE);
    })();
    try {
      await bucketReady;
    } catch (error) {
      bucketReady = null;
      throw error;
    }
  }

  return {
    async put(input) {
      const objectKey = `${SUPPORT_ATTACHMENT_PREFIX}${input.requestId}/${nid()}`;
      assertSupportKey(objectKey);
      await ensureBucket();
      await client.putObject(
        SUPPORT_ATTACHMENT_BUCKET,
        objectKey,
        input.bytes,
        input.bytes.length,
        { 'Content-Type': input.contentType },
      );
      return {
        objectKey,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.bytes.length,
      };
    },

    async remove(objectKeys) {
      if (objectKeys.length === 0) return;
      objectKeys.forEach(assertSupportKey);
      await Promise.all(
        objectKeys.map((objectKey) => client.removeObject(SUPPORT_ATTACHMENT_BUCKET, objectKey)),
      );
    },
  };
}
