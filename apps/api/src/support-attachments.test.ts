import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_ATTACHMENT_BUCKET,
  SUPPORT_ATTACHMENT_PREFIX,
} from '@seed/shared/support-attachments';
import { createSupportAttachmentStore, type SupportAttachmentClient } from './support-attachments';

const upload = {
  filename: 'error.png',
  contentType: 'image/png' as const,
  bytes: Buffer.from('image'),
};

function makeClient(exists = true): SupportAttachmentClient {
  return {
    bucketExists: vi.fn(async () => exists),
    makeBucket: vi.fn(async () => {}),
    setBucketLifecycle: vi.fn(async () => {}),
    putObject: vi.fn(async () => {}),
    removeObject: vi.fn(async () => {}),
  };
}

describe('SupportAttachmentStore', () => {
  it('does not require bucket-admin bootstrap permissions in production', async () => {
    const client = makeClient(false);
    const store = createSupportAttachmentStore({ NODE_ENV: 'production' }, client);

    const ref = await store.put({ ...upload, requestId: 'request.id' });

    expect(ref.filename).toBe('error.png');
    expect(ref.sizeBytes).toBe(5);
    expect(ref.objectKey).toMatch(/^support\/request\.id\/[A-Za-z0-9_-]{21}$/);
    expect(client.bucketExists).not.toHaveBeenCalled();
    expect(client.makeBucket).not.toHaveBeenCalled();
    expect(client.setBucketLifecycle).not.toHaveBeenCalled();
    expect(client.putObject).toHaveBeenCalledWith(
      SUPPORT_ATTACHMENT_BUCKET,
      ref.objectKey,
      upload.bytes,
      upload.bytes.length,
      { 'Content-Type': 'image/png' },
    );
  });

  it('bootstraps local MinIO once and tolerates a first-upload race', async () => {
    const client = makeClient(false);
    vi.mocked(client.makeBucket).mockRejectedValue(
      Object.assign(new Error('already exists'), { statusCode: 409 }),
    );
    const store = createSupportAttachmentStore({ NODE_ENV: 'test' }, client);

    await store.put({ ...upload, requestId: 'request-1' });
    await store.put({ ...upload, requestId: 'request-2' });

    expect(client.bucketExists).toHaveBeenCalledTimes(1);
    expect(client.makeBucket).toHaveBeenCalledTimes(1);
    expect(client.setBucketLifecycle).toHaveBeenCalledTimes(1);
    expect(client.putObject).toHaveBeenCalledTimes(2);
  });

  it('rejects an unsafe request id before touching storage', async () => {
    const client = makeClient();
    const store = createSupportAttachmentStore({ NODE_ENV: 'production' }, client);

    await expect(store.put({ ...upload, requestId: '../escape' })).rejects.toThrow(
      'invalid support attachment key',
    );
    expect(client.putObject).not.toHaveBeenCalled();
    expect(client.bucketExists).not.toHaveBeenCalled();
  });

  it('validates all delete keys before deleting any object', async () => {
    const client = makeClient();
    const store = createSupportAttachmentStore({ NODE_ENV: 'production' }, client);

    await expect(
      store.remove([`${SUPPORT_ATTACHMENT_PREFIX}request/file_1`, 'support/../escape']),
    ).rejects.toThrow('invalid support attachment key');
    expect(client.removeObject).not.toHaveBeenCalled();
  });
});
