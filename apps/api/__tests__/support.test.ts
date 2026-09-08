import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { setupSupportRoutes, type SupportEmailPayload } from '../src/support';
import type { SupportAttachmentStore, SupportAttachmentUpload } from '../src/support-attachments';
import {
  SUPPORT_ATTACHMENT_MAX_FILE_BYTES,
  SUPPORT_ATTACHMENT_MAX_FILES,
  SUPPORT_ATTACHMENT_MAX_PARTS,
  SUPPORT_ATTACHMENT_MAX_TEXT_BYTES,
} from '@seed/shared/support-attachments';

describe('support form route', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function makeApp(
    sent: SupportEmailPayload[] = [],
    attachmentStore?: SupportAttachmentStore,
    enqueue?: (payload: SupportEmailPayload) => Promise<void>,
  ): FastifyInstance {
    app = Fastify();
    void app.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        files: SUPPORT_ATTACHMENT_MAX_FILES + 1,
        fileSize: SUPPORT_ATTACHMENT_MAX_FILE_BYTES,
        fields: 5,
        parts: SUPPORT_ATTACHMENT_MAX_PARTS,
        fieldSize: SUPPORT_ATTACHMENT_MAX_TEXT_BYTES,
      },
    });
    setupSupportRoutes(app, {
      isMailerConfigured: () => true,
      enqueue:
        enqueue ??
        (async (payload) => {
          sent.push(payload);
        }),
      ...(attachmentStore ? { attachmentStore } : {}),
    });
    return app;
  }

  function multipartBody(
    parts: Array<
      | { name: string; value: string }
      | { name: string; filename: string; contentType: string; bytes: Buffer }
    >,
  ): { payload: Buffer; contentType: string } {
    const boundary = 'support-test-boundary';
    const chunks: Buffer[] = [];
    for (const part of parts) {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      if ('filename' in part) {
        chunks.push(
          Buffer.from(
            `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
              `Content-Type: ${part.contentType}\r\n\r\n`,
          ),
          part.bytes,
          Buffer.from('\r\n'),
        );
      } else {
        chunks.push(
          Buffer.from(
            `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          ),
        );
      }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return {
      payload: Buffer.concat(chunks),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  it('queues a support request without exposing payment secrets in the form contract', async () => {
    const sent: SupportEmailPayload[] = [];
    const server = makeApp(sent);
    const res = await server.inject({
      method: 'POST',
      url: '/v1/support',
      payload: {
        email: 'buyer@example.com',
        topic: 'refund',
        orderId: 'order-123',
        message: 'Прошу проверить возврат по этому заказу.',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'support@vertov.space',
      subject: '[Vertov support] Возврат денег',
    });
    expect(sent[0]?.text).toContain('Order ID: order-123');
    expect(sent[0]?.text).toContain('Прошу проверить возврат');
  });

  it('rejects malformed submissions before enqueueing', async () => {
    const sent: SupportEmailPayload[] = [];
    const server = makeApp(sent);
    const res = await server.inject({
      method: 'POST',
      url: '/v1/support',
      payload: { email: 'not-an-email', topic: 'general', message: 'short' },
    });

    expect(res.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('stores valid attachments and queues only private object references', async () => {
    const sent: SupportEmailPayload[] = [];
    const uploaded: SupportAttachmentUpload[] = [];
    const attachmentStore: SupportAttachmentStore = {
      put: async (input) => {
        uploaded.push(input);
        return {
          objectKey: 'support/test/image-1',
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.bytes.length,
        };
      },
      remove: async () => {},
    };
    const server = makeApp(sent, attachmentStore);
    const body = multipartBody([
      { name: 'email', value: 'buyer@example.com' },
      { name: 'topic', value: 'technical' },
      { name: 'orderId', value: '' },
      { name: 'message', value: 'Прикладываю скриншот ошибки в приложении.' },
      { name: 'website', value: '' },
      {
        name: 'attachments',
        filename: 'error.png',
        contentType: 'image/png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ]);

    const res = await server.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { 'content-type': body.contentType },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(202);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.contentType).toBe('image/png');
    expect(sent[0]?.text).toContain('Вложения: 1');
    expect(sent[0]?.attachments).toEqual([
      {
        objectKey: 'support/test/image-1',
        filename: 'error.png',
        contentType: 'image/png',
        sizeBytes: 8,
      },
    ]);
    expect(sent[0]?.attachments?.[0]).not.toHaveProperty('bytes');
  });

  it('rejects a file whose bytes do not match an allowed attachment type', async () => {
    const sent: SupportEmailPayload[] = [];
    const uploaded: SupportAttachmentUpload[] = [];
    const attachmentStore: SupportAttachmentStore = {
      put: async (input) => {
        uploaded.push(input);
        return {
          objectKey: 'support/test/should-not-exist',
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.bytes.length,
        };
      },
      remove: async () => {},
    };
    const server = makeApp(sent, attachmentStore);
    const body = multipartBody([
      { name: 'email', value: 'buyer@example.com' },
      { name: 'topic', value: 'technical' },
      { name: 'orderId', value: '' },
      { name: 'message', value: 'Это невалидное вложение для проверки.' },
      { name: 'website', value: '' },
      {
        name: 'attachments',
        filename: 'payload.exe',
        contentType: 'application/octet-stream',
        bytes: Buffer.from('not an image or pdf'),
      },
      {
        name: 'attachments',
        filename: 'later.png',
        contentType: 'image/png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ]);

    const res = await server.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { 'content-type': body.contentType },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_attachments' });
    expect(uploaded).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('rejects more than the allowed number of files before enqueueing', async () => {
    const sent: SupportEmailPayload[] = [];
    const server = makeApp(sent, {
      put: async () => {
        throw new Error('must not upload');
      },
      remove: async () => {},
    });
    const body = multipartBody([
      { name: 'email', value: 'buyer@example.com' },
      { name: 'topic', value: 'technical' },
      { name: 'message', value: 'Проверка лимита количества файлов.' },
      ...Array.from({ length: SUPPORT_ATTACHMENT_MAX_FILES + 1 }, (_, index) => ({
        name: 'attachments',
        filename: `image-${index}.png`,
        contentType: 'image/png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      })),
    ]);

    const res = await server.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { 'content-type': body.contentType },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'invalid_attachments' });
    expect(sent).toHaveLength(0);
  });

  it('retains uploaded objects when durable enqueue has an ambiguous outcome', async () => {
    const removed: string[][] = [];
    const attachmentStore: SupportAttachmentStore = {
      put: async (input) => ({
        objectKey: `support/test/${input.filename.replace('.', '-')}`,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.bytes.length,
      }),
      remove: async (keys) => {
        removed.push(keys);
      },
    };
    const server = makeApp([], attachmentStore, async () => {
      throw new Error('outbox unavailable');
    });
    const body = multipartBody([
      { name: 'email', value: 'buyer@example.com' },
      { name: 'topic', value: 'technical' },
      { name: 'message', value: 'Проверка очистки после ошибки очереди.' },
      {
        name: 'attachments',
        filename: 'error.png',
        contentType: 'image/png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ]);

    const res = await server.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { 'content-type': body.contentType },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(503);
    expect(removed).toEqual([]);
  });

  it('acknowledges the honeypot without sending spam', async () => {
    const sent: SupportEmailPayload[] = [];
    const server = makeApp(sent);
    const res = await server.inject({
      method: 'POST',
      url: '/v1/support',
      payload: {
        email: 'bot@example.com',
        topic: 'general',
        message: 'This is a bot submission.',
        website: 'https://spam.invalid',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(0);
  });
});
