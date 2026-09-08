import { Client as MinioClient } from 'minio';
import type { AuthEmailAttachment } from '@seed/credits';
import {
  SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES,
  SUPPORT_ATTACHMENT_BUCKET,
  SUPPORT_ATTACHMENT_MAX_FILE_BYTES,
  isSafeSupportAttachmentKey,
  isSafeSupportAttachmentFilename,
} from '@seed/shared/support-attachments';

const DEFAULT_READ_TIMEOUT_MS = 30_000;

function parseEndpoint(raw: string): { endPoint: string; port: number; useSSL: boolean } {
  const endpoint = new URL(raw);
  return {
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    useSSL: endpoint.protocol === 'https:',
  };
}

function isAllowedContentType(contentType: string): boolean {
  return SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES.includes(
    contentType as (typeof SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES)[number],
  );
}

export interface SupportAttachmentClient {
  getObject(
    bucketName: string,
    objectName: string,
  ): Promise<AsyncIterable<Buffer | Uint8Array | string>>;
  removeObject(bucketName: string, objectName: string): Promise<void>;
}

export interface SupportAttachmentAccess {
  read(attachment: AuthEmailAttachment): Promise<Buffer>;
  remove(objectKeys: string[]): Promise<void>;
}

/** Reads private support objects for the SMTP worker and removes them on success. */
export class SupportAttachmentStorage implements SupportAttachmentAccess {
  private readonly client: SupportAttachmentClient;
  private readonly readTimeoutMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env, client?: SupportAttachmentClient) {
    const endpoint = parseEndpoint(env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000');
    this.client =
      client ??
      (new MinioClient({
        ...endpoint,
        accessKey: env.MINIO_ROOT_USER ?? 'seedminio',
        secretKey: env.MINIO_ROOT_PASSWORD ?? 'CHANGE_ME_HEX24',
        region: env.S3_REGION ?? env.MINIO_REGION ?? 'us-east-1',
      }) as unknown as SupportAttachmentClient);
    const configuredTimeout = Number(
      env.SUPPORT_ATTACHMENT_READ_TIMEOUT_MS ?? DEFAULT_READ_TIMEOUT_MS,
    );
    this.readTimeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_READ_TIMEOUT_MS;
  }

  async read(attachment: AuthEmailAttachment): Promise<Buffer> {
    if (
      !isSafeSupportAttachmentKey(attachment.objectKey) ||
      !isSafeSupportAttachmentFilename(attachment.filename) ||
      !isAllowedContentType(attachment.contentType) ||
      !Number.isInteger(attachment.sizeBytes) ||
      attachment.sizeBytes < 1 ||
      attachment.sizeBytes > SUPPORT_ATTACHMENT_MAX_FILE_BYTES
    ) {
      throw new Error('invalid support attachment reference');
    }

    let stream: AsyncIterable<Buffer | Uint8Array | string> & {
      destroy?: (error?: Error) => void;
    };
    let timedOut = false;
    const timeoutError = new Error('support attachment read timed out');
    const readPromise = (async () => {
      stream = await this.client.getObject(SUPPORT_ATTACHMENT_BUCKET, attachment.objectKey);
      if (timedOut) {
        stream.destroy?.(timeoutError);
        throw timeoutError;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.length;
        if (totalBytes > SUPPORT_ATTACHMENT_MAX_FILE_BYTES) {
          stream.destroy?.(new Error('support attachment exceeds size limit'));
          throw new Error('support attachment exceeds size limit');
        }
        chunks.push(bytes);
      }
      if (totalBytes !== attachment.sizeBytes) {
        throw new Error('support attachment size mismatch');
      }
      return Buffer.concat(chunks, totalBytes);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        stream?.destroy?.(timeoutError);
        reject(timeoutError);
      }, this.readTimeoutMs);
    });
    try {
      return await Promise.race([readPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async remove(objectKeys: string[]): Promise<void> {
    if (objectKeys.length === 0) return;
    if (objectKeys.some((objectKey) => !isSafeSupportAttachmentKey(objectKey))) {
      throw new Error('invalid support attachment key');
    }
    await Promise.all(
      objectKeys.map((objectKey) => this.client.removeObject(SUPPORT_ATTACHMENT_BUCKET, objectKey)),
    );
  }
}
