import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReceipt, createFailureOutcome, createYooKassaAdapter } from '../src/index';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.YOOKASSA_SHOP_ID;
  delete process.env.YOOKASSA_SECRET_KEY;
  delete process.env.YOOKASSA_MODE;
  delete process.env.YOOKASSA_WEBHOOK_SECRET;
  delete process.env.YOOKASSA_BASE_URL;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe('createYooKassaAdapter — mode selection', () => {
  it('defaults to stub when shop id/secret missing', () => {
    const a = createYooKassaAdapter({});
    expect(a.mode).toBe('stub');
  });

  it('returns live when both shop id and secret are set', () => {
    const a = createYooKassaAdapter({
      YOOKASSA_SHOP_ID: '1234',
      YOOKASSA_SECRET_KEY: 'test_secret',
    });
    expect(a.mode).toBe('live');
  });

  it('YOOKASSA_MODE=stub forces stub even with creds', () => {
    const a = createYooKassaAdapter({
      YOOKASSA_MODE: 'stub',
      YOOKASSA_SHOP_ID: '1234',
      YOOKASSA_SECRET_KEY: 'test_secret',
    });
    expect(a.mode).toBe('stub');
  });
});

describe('stub createPayment', () => {
  it('returns a forceSuccess return URL and synthetic payment id', async () => {
    const a = createYooKassaAdapter({});
    const out = await a.createPayment({
      amountRub: 199,
      orderId: 'ord_1',
      userId: 'u_1',
      itemId: 'pack-200',
      kind: 'pack',
      returnUrl: 'http://127.0.0.1:3000/billing/return?orderId=ord_1',
      description: 'pack',
    });
    expect(out.providerPaymentId).toBe('stub-ord_1');
    expect(out.confirmationUrl).toBe(
      'http://127.0.0.1:3000/billing/return?orderId=ord_1&forceSuccess=1',
    );
    expect(out.status).toBe('pending');
  });

  it('handles return URL without a query string', async () => {
    const a = createYooKassaAdapter({});
    const out = await a.createPayment({
      amountRub: 199,
      orderId: 'ord_2',
      userId: 'u_2',
      itemId: 'pack-200',
      kind: 'pack',
      returnUrl: 'http://127.0.0.1:3000/billing/return',
      description: 'pack',
    });
    expect(out.confirmationUrl).toBe('http://127.0.0.1:3000/billing/return?forceSuccess=1');
  });
});

describe('live createPayment', () => {
  it('posts with Basic auth + Idempotence-Key + RUB amount + metadata', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: 'pay_abc',
          status: 'pending',
          confirmation: { type: 'redirect', confirmation_url: 'https://yookassa/redir' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const a = createYooKassaAdapter(
      { YOOKASSA_SHOP_ID: 'shop123', YOOKASSA_SECRET_KEY: 'secretXYZ' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    const out = await a.createPayment({
      amountRub: 490,
      orderId: 'ord_live_1',
      userId: 'u_live',
      itemId: 'creator',
      kind: 'subscription',
      returnUrl: 'http://x/return',
      description: 'sub creator',
    });
    expect(out.providerPaymentId).toBe('pay_abc');
    expect(out.confirmationUrl).toBe('https://yookassa/redir');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.yookassa.ru/v3/payments');
    const headers = init!.headers as Record<string, string>;
    const expectedBasic = Buffer.from('shop123:secretXYZ').toString('base64');
    expect(headers['Authorization']).toBe(`Basic ${expectedBasic}`);
    expect(headers['Idempotence-Key']).toBe('ord_live_1');
    const body = JSON.parse(init!.body as string);
    expect(body.amount).toEqual({ value: '490.00', currency: 'RUB' });
    expect(body.capture).toBe(true);
    expect(body.confirmation).toEqual({ type: 'redirect', return_url: 'http://x/return' });
    expect(body.metadata).toEqual({
      orderId: 'ord_live_1',
      userId: 'u_live',
      itemId: 'creator',
      kind: 'subscription',
    });
  });

  it('throws when upstream returns non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"x"}', { status: 401 }));
    const a = createYooKassaAdapter(
      { YOOKASSA_SHOP_ID: 's', YOOKASSA_SECRET_KEY: 'k' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await expect(
      a.createPayment({
        amountRub: 1,
        orderId: 'o',
        userId: 'u',
        itemId: 'p',
        kind: 'pack',
        returnUrl: 'http://x',
        description: 'd',
      }),
    ).rejects.toThrow(/yookassa payment create failed: 401/);
  });
});

describe('buildReceipt — 54-ФЗ чек', () => {
  const base = {
    amountRub: 490,
    orderId: 'o',
    userId: 'u',
    itemId: 'creator',
    kind: 'subscription' as const,
    returnUrl: 'http://x',
    description: 'sub creator',
  };

  it('builds an email receipt with УСН-доход defaults (vat_code 1, tax_system_code 2)', () => {
    const r = buildReceipt({}, { ...base, customerEmail: 'buyer@example.com' });
    expect(r).toEqual({
      customer: { email: 'buyer@example.com' },
      tax_system_code: 2,
      items: [
        {
          description: 'sub creator',
          quantity: '1.00',
          amount: { value: '490.00', currency: 'RUB' },
          vat_code: 1,
          payment_mode: 'full_payment',
          payment_subject: 'service',
        },
      ],
    });
  });

  it('prefers email over phone, and uses receiptDescription for the line label', () => {
    const r = buildReceipt(
      {},
      {
        ...base,
        customerEmail: 'buyer@example.com',
        customerPhone: '+79001234567',
        receiptDescription: 'Подписка Creator',
      },
    ) as { customer: unknown; items: Array<{ description: string }> };
    expect(r.customer).toEqual({ email: 'buyer@example.com' });
    expect(r.items[0]!.description).toBe('Подписка Creator');
  });

  it('falls back to phone when no email (phone-OTP signups)', () => {
    const r = buildReceipt({}, { ...base, customerEmail: null, customerPhone: '+79001234567' });
    expect(r?.customer).toEqual({ phone: '+79001234567' });
  });

  it('omits the receipt entirely when there is no contact to send the чек to', () => {
    expect(buildReceipt({}, { ...base, customerEmail: null, customerPhone: null })).toBeUndefined();
    expect(buildReceipt({}, base)).toBeUndefined();
  });

  it('honours env overrides for the УСН variant and НДС code', () => {
    const r = buildReceipt(
      { YOOKASSA_TAX_SYSTEM_CODE: '3', YOOKASSA_VAT_CODE: '6' },
      { ...base, customerEmail: 'b@e.com' },
    ) as { tax_system_code: number; items: Array<{ vat_code: number }> };
    expect(r.tax_system_code).toBe(3);
    expect(r.items[0]!.vat_code).toBe(6);
  });

  it('truncates an over-long line label to 128 chars (54-ФЗ limit)', () => {
    const r = buildReceipt(
      {},
      { ...base, customerEmail: 'b@e.com', receiptDescription: 'x'.repeat(200) },
    ) as { items: Array<{ description: string }> };
    expect(r.items[0]!.description).toHaveLength(128);
  });
});

describe('live createPayment — receipt attachment', () => {
  function mockOk() {
    return vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'pay_abc',
            status: 'pending',
            confirmation: { type: 'redirect', confirmation_url: 'https://yk/redir' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
  }

  it('attaches the receipt to the payment body when a contact is on file', async () => {
    const fetchMock = mockOk();
    const a = createYooKassaAdapter(
      { YOOKASSA_SHOP_ID: 's', YOOKASSA_SECRET_KEY: 'k' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await a.createPayment({
      amountRub: 490,
      orderId: 'o',
      userId: 'u',
      itemId: 'creator',
      kind: 'subscription',
      returnUrl: 'http://x',
      description: 'sub creator',
      customerEmail: 'buyer@example.com',
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.receipt.customer).toEqual({ email: 'buyer@example.com' });
    expect(body.receipt.items[0]!.amount).toEqual({ value: '490.00', currency: 'RUB' });
  });

  it('omits the receipt key when no contact is available', async () => {
    const fetchMock = mockOk();
    const a = createYooKassaAdapter(
      { YOOKASSA_SHOP_ID: 's', YOOKASSA_SECRET_KEY: 'k' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await a.createPayment({
      amountRub: 490,
      orderId: 'o',
      userId: 'u',
      itemId: 'creator',
      kind: 'subscription',
      returnUrl: 'http://x',
      description: 'sub creator',
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body).not.toHaveProperty('receipt');
  });
});

describe('verifyWebhook (Bearer scheme)', () => {
  it('accepts matching bearer token', () => {
    process.env.YOOKASSA_WEBHOOK_SECRET = 'super-secret';
    const a = createYooKassaAdapter({});
    const r = a.verifyWebhook({ rawBody: '{}', headers: { authorization: 'Bearer super-secret' } });
    expect(r.ok).toBe(true);
  });

  it('rejects tampered bearer token with mismatch reason', () => {
    process.env.YOOKASSA_WEBHOOK_SECRET = 'super-secret';
    const a = createYooKassaAdapter({});
    const r = a.verifyWebhook({
      rawBody: '{}',
      headers: { authorization: 'Bearer wrong-secret!' },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects missing header when secret set', () => {
    process.env.YOOKASSA_WEBHOOK_SECRET = 'super-secret';
    const a = createYooKassaAdapter({});
    const r = a.verifyWebhook({ rawBody: '{}', headers: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_header');
  });

  it('fails closed in production when no secret is configured', () => {
    process.env.NODE_ENV = 'production';
    const a = createYooKassaAdapter({});
    expect(a.verifyWebhook({ rawBody: '{}', headers: {} }).ok).toBe(false);
  });

  it('accepts in dev when no secret configured (test ergonomics)', () => {
    const a = createYooKassaAdapter({});
    expect(a.verifyWebhook({ rawBody: '{}', headers: {} }).ok).toBe(true);
  });
});

describe('W1-0: a failed create must say whether a payment can exist', () => {
  const live = { YOOKASSA_SHOP_ID: 'shop', YOOKASSA_SECRET_KEY: 'key' };
  const input = {
    amountRub: 199,
    orderId: 'ord-1',
    userId: 'u-1',
    itemId: 'pack-s',
    kind: 'pack' as const,
    returnUrl: 'https://vertov.space/billing/return?orderId=ord-1',
    description: 'Pack S',
  };

  it('classifies only outright refusals as rejected', () => {
    // These prove ЮKassa refused the request before a payment could exist.
    expect(createFailureOutcome(400)).toBe('rejected');
    expect(createFailureOutcome(401)).toBe('rejected');
    expect(createFailureOutcome(403)).toBe('rejected');
    expect(createFailureOutcome(404)).toBe('rejected');
    expect(createFailureOutcome(422)).toBe('rejected');
    // 409 is an idempotency-key conflict — a payment very probably DOES exist.
    expect(createFailureOutcome(409)).toBe('unknown');
    // The request may still have landed.
    expect(createFailureOutcome(408)).toBe('unknown');
    expect(createFailureOutcome(429)).toBe('unknown');
    expect(createFailureOutcome(500)).toBe('unknown');
    expect(createFailureOutcome(503)).toBe('unknown');
  });

  it('a 400 create surfaces as a rejected PaymentCreateError', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad amount', { status: 400 }));
    const a = createYooKassaAdapter(live, { fetch: fetchImpl as unknown as typeof fetch });
    await expect(a.createPayment(input)).rejects.toMatchObject({
      name: 'PaymentCreateError',
      outcome: 'rejected',
      status: 400,
    });
  });

  it('a transport failure surfaces as UNKNOWN — the payment may exist', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const a = createYooKassaAdapter(live, { fetch: fetchImpl as unknown as typeof fetch });
    await expect(a.createPayment(input)).rejects.toMatchObject({ outcome: 'unknown' });
  });

  it('a 2xx we cannot parse is UNKNOWN, not a refusal', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not json</html>', { status: 200 }));
    const a = createYooKassaAdapter(live, { fetch: fetchImpl as unknown as typeof fetch });
    await expect(a.createPayment(input)).rejects.toMatchObject({ outcome: 'unknown' });
  });

  it('a 2xx with no confirmation_url is UNKNOWN — the payment was created', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'pay-1', status: 'pending' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const a = createYooKassaAdapter(live, { fetch: fetchImpl as unknown as typeof fetch });
    await expect(a.createPayment(input)).rejects.toMatchObject({ outcome: 'unknown' });
  });
});

describe('W1-0: retrievePayment is the check behind a metadata-resolved webhook', () => {
  const live = { YOOKASSA_SHOP_ID: 'shop', YOOKASSA_SECRET_KEY: 'key' };

  it('reads back status and amount', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 'pay-1', status: 'succeeded', amount: { value: '199.00' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const a = createYooKassaAdapter(live, { fetch: fetchImpl as unknown as typeof fetch });
    await expect(a.retrievePayment('pay-1')).resolves.toEqual({
      providerPaymentId: 'pay-1',
      status: 'succeeded',
      amountRub: 199,
    });
  });

  it('returns null when the provider does not know the payment', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    const a = createYooKassaAdapter(live, { fetch: fetchImpl as unknown as typeof fetch });
    await expect(a.retrievePayment('nope')).resolves.toBeNull();
  });

  it('THROWS when the lookup itself failed — never readable as "no payment"', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const a = createYooKassaAdapter(live, { fetch: fetchImpl as unknown as typeof fetch });
    await expect(a.retrievePayment('pay-1')).rejects.toThrow(/retrieve failed/);
  });

  it('the stub confirms a status but asserts NO amount', async () => {
    const a = createYooKassaAdapter({});
    await expect(a.retrievePayment('stub-ord-1')).resolves.toEqual({
      providerPaymentId: 'stub-ord-1',
      status: 'succeeded',
      amountRub: null,
    });
  });
});
