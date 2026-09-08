import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AuthEmailAttachment } from '@seed/credits';
import {
  SUPPORT_ATTACHMENT_BUCKET,
  SUPPORT_ATTACHMENT_MAX_FILE_BYTES,
} from '@seed/shared/support-attachments';
import {
  SupportAttachmentStorage,
  type SupportAttachmentClient,
} from './support-attachment-storage';

const env = {
  MINIO_ENDPOINT: 'http://127.0.0.1:9000',
  MINIO_ROOT_USER: 'test',
  MINIO_ROOT_PASSWORD: 'test-password',
};

const reference: AuthEmailAttachment = {
  objectKey: 'support/request.id/file_1',
  filename: 'error.png',
  contentType: 'image/png',
  sizeBytes: 5,
};

function makeClient(bytes: Buffer): SupportAttachmentClient {
  return {
    getObject: vi.fn(async () => Readable.from([bytes])),
    removeObject: vi.fn(async () => {}),
  };
}

describe('SupportAttachmentStorage', () => {
  it('reads a private object and verifies its declared size', async () => {
    const client = makeClient(Buffer.from('image'));
    const storage = new SupportAttachmentStorage(env, client);

    await expect(storage.read(reference)).resolves.toEqual(Buffer.from('image'));
    expect(client.getObject).toHaveBeenCalledWith(SUPPORT_ATTACHMENT_BUCKET, reference.objectKey);
  });

  it('rejects a reference whose object size does not match the queue payload', async () => {
    const storage = new SupportAttachmentStorage(env, makeClient(Buffer.from('wrong')));

    await expect(storage.read({ ...reference, sizeBytes: 4 })).rejects.toThrow(
      'support attachment size mismatch',
    );
  });

  it('rejects unsafe keys and unsupported filenames before touching storage', async () => {
    const client = makeClient(Buffer.from('image'));
    const storage = new SupportAttachmentStorage(env, client);

    await expect(storage.read({ ...reference, objectKey: 'support/../escape' })).rejects.toThrow(
      'invalid support attachment reference',
    );
    await expect(storage.read({ ...reference, filename: 'nested/error.png' })).rejects.toThrow(
      'invalid support attachment reference',
    );
    expect(client.getObject).not.toHaveBeenCalled();
  });

  it('stops oversized object streams before returning them', async () => {
    const destroy = vi.fn();
    const stream = Object.assign(
      Readable.from([Buffer.alloc(SUPPORT_ATTACHMENT_MAX_FILE_BYTES + 1)]),
      {
        destroy,
      },
    );
    const client: SupportAttachmentClient = {
      getObject: vi.fn(async () => stream),
      removeObject: vi.fn(async () => {}),
    };
    const storage = new SupportAttachmentStorage(env, client);

    await expect(
      storage.read({ ...reference, sizeBytes: SUPPORT_ATTACHMENT_MAX_FILE_BYTES }),
    ).rejects.toThrow('support attachment exceeds size limit');
    expect(destroy).toHaveBeenCalled();
  });

  it('times out a stalled object stream and destroys it', async () => {
    const destroy = vi.fn();
    const stream: AsyncIterable<Buffer> & { destroy: typeof destroy } = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Buffer>>(() => {}),
        };
      },
      destroy,
    };
    const client: SupportAttachmentClient = {
      getObject: vi.fn(async () => stream),
      removeObject: vi.fn(async () => {}),
    };
    const storage = new SupportAttachmentStorage(
      { ...env, SUPPORT_ATTACHMENT_READ_TIMEOUT_MS: '5' },
      client,
    );

    await expect(storage.read(reference)).rejects.toThrow('support attachment read timed out');
    expect(destroy).toHaveBeenCalled();
  });

  it('removes only validated support keys', async () => {
    const client = makeClient(Buffer.from('image'));
    const storage = new SupportAttachmentStorage(env, client);

    await storage.remove([reference.objectKey]);
    expect(client.removeObject).toHaveBeenCalledWith(
      SUPPORT_ATTACHMENT_BUCKET,
      reference.objectKey,
    );
    await expect(storage.remove(['support/../escape'])).rejects.toThrow(
      'invalid support attachment key',
    );
  });
});
