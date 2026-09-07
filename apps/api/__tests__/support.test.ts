import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupSupportRoutes, type SupportEmailPayload } from '../src/support';

describe('support form route', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function makeApp(sent: SupportEmailPayload[] = []): FastifyInstance {
    app = Fastify();
    setupSupportRoutes(app, {
      isMailerConfigured: () => true,
      enqueue: async (payload) => {
        sent.push(payload);
      },
    });
    return app;
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
