import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createTochkaProvider, _internal } from '../src';

const russianRootCa = fileURLToPath(
  new URL('../../../../infra/compute/russian-trusted-root-ca.crt', import.meta.url),
);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Tochka provider', () => {
  it('uses sandbox token and creates a payment link with paymentLinkId', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        Data: {
          operationId: 'op_1',
          paymentLink: 'https://pay.tochka/op_1',
          status: 'CREATED',
          paymentLinkId: 'ord_1',
        },
      }),
    );
    const provider = createTochkaProvider(
      { TOCHKA_MODE: 'sandbox', TOCHKA_CUSTOMER_CODE: 'customer', TOCHKA_MERCHANT_ID: 'merchant' },
      { fetch: fetchMock, log: () => undefined },
    );
    const result = await provider.createPayment({
      amountRub: 99,
      orderId: 'ord_1',
      kind: 'pack',
      purpose: 'Pack',
      returnUrl: 'https://app/return',
      itemTitle: 'Pack',
    });
    expect(result).toEqual({
      confirmationUrl: 'https://pay.tochka/op_1',
      providerPaymentId: 'op_1',
      status: 'CREATED',
      paymentLinkId: 'ord_1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://enter.tochka.com/sandbox/v2/acquiring/v1.0/payments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sandbox.jwt.token' }),
      }),
    );
    const call = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(call?.body))).toMatchObject({
      Data: {
        amount: '99.00',
        paymentLinkId: 'ord_1',
        customerCode: 'customer',
        paymentMode: ['card', 'sbp'],
      },
    });
  });

  it('creates a receipt subscription and exposes the provider operation id', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        Data: {
          operationId: 'sub_1',
          paymentLink: 'https://pay.tochka/sub_1',
          consumerId: 'consumer_1',
        },
      }),
    );
    const provider = createTochkaProvider(
      { TOCHKA_MODE: 'sandbox', TOCHKA_CUSTOMER_CODE: 'customer', TOCHKA_USE_RECEIPTS: 'true' },
      { fetch: fetchMock, log: () => undefined },
    );
    const result = await provider.createSubscription({
      amountRub: 499,
      orderId: 'ord_sub',
      purpose: 'Subscription',
      returnUrl: 'https://app/return',
      customerEmail: 'buyer@example.com',
      itemTitle: 'Start',
    });
    expect(result.providerSubscriptionId).toBe('sub_1');
    expect(result.consumerId).toBe('consumer_1');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/acquiring/v1.0/subscriptions_with_receipt');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      Data: {
        Client: { email: 'buyer@example.com' },
        Items: [{ name: 'Start' }],
        Options: { period: 'Month' },
        paymentMode: ['card'],
      },
    });
  });

  it('never invents a local payment id when a renewal charge omits the PSP id', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ Data: { status: 'PENDING' } }));
    const provider = createTochkaProvider(
      { TOCHKA_MODE: 'sandbox' },
      { fetch: fetchMock, log: () => undefined },
    );

    await expect(
      provider.chargeSubscription({
        subscriptionId: 'sub_1',
        amountRub: 499,
        purpose: 'Renewal',
        paymentLinkId: 'renewal-order-1',
        itemTitle: 'Renewal',
      }),
    ).rejects.toThrow('missing operationId');
  });

  it('uses a stable refundUid for full and partial refund retries', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ Data: { refundUid: 'refund-1', status: 'WAITING' } }));
    const provider = createTochkaProvider(
      { TOCHKA_MODE: 'sandbox' },
      { fetch: fetchMock, log: () => undefined },
    );

    await provider.refundPayment('payment-1', 99.5, 'refund-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://enter.tochka.com/sandbox/v2/acquiring/v1.0/payments/payment-1/refund',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      Data: { refundUid: 'refund-1', amount: '99.50' },
    });
  });

  it('rejects a refund request without a provider idempotency key', async () => {
    const provider = createTochkaProvider(
      { TOCHKA_MODE: 'sandbox' },
      { fetch: vi.fn(), log: () => undefined },
    );
    await expect(provider.refundPayment('payment-1', undefined, '')).rejects.toThrow(
      'refundUid is required',
    );
  });

  it('uses a provider-scoped CA dispatcher when Tochka needs its Russian TLS chain', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ Data: {} }));
    const provider = createTochkaProvider(
      {
        TOCHKA_MODE: 'sandbox',
        TOCHKA_CA_CERT: russianRootCa,
      },
      { fetch: fetchMock, log: () => undefined },
    );

    await provider.getCustomers();

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        dispatcher: expect.anything(),
      }),
    );
  });

  it('uses the CA dispatcher when fetching a dynamic webhook public key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ kty: 'RSA', n: 'bad', e: 'AQAB' }));
    const provider = createTochkaProvider(
      {
        TOCHKA_MODE: 'sandbox',
        TOCHKA_CA_CERT: russianRootCa,
        TOCHKA_PUBLIC_KEY_URL: 'https://keys.tochka.test/jwk.json',
      },
      { fetch: fetchMock, log: () => undefined },
    );

    await provider.verifyWebhook({ rawBody: 'not-a-jwt' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://keys.tochka.test/jwk.json',
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
  });

  it('fails closed when a live JWT is missing', async () => {
    const provider = createTochkaProvider(
      { TOCHKA_MODE: 'live' },
      { fetch: vi.fn(), log: () => undefined },
    );
    await expect(provider.getPaymentInfo('op_1')).rejects.toThrow('TOCHKA_JWT is required');
  });

  it('rejects an absent webhook key and invalid signed payload', async () => {
    const noKey = createTochkaProvider({ TOCHKA_MODE: 'sandbox' }, { log: () => undefined });
    await expect(noKey.verifyWebhook({ rawBody: 'x' })).resolves.toMatchObject({
      ok: false,
      reason: 'missing_key',
    });
    const invalid = createTochkaProvider(
      { TOCHKA_MODE: 'sandbox', TOCHKA_WEBHOOK_PUBLIC_KEY: '{"kty":"RSA","n":"bad","e":"AQAB"}' },
      { log: () => undefined },
    );
    await expect(
      invalid.verifyWebhook({ rawBody: 'eyJhbGciOiJSUzI1NiJ9.invalid.sig' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_jwt' });
  });

  it('formats positive ruble amounts deterministically', () => {
    expect(_internal.amount(1)).toBe('1.00');
    expect(() => _internal.amount(0)).toThrow();
  });
});
