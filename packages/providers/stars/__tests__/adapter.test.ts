import { describe, expect, it, vi } from 'vitest';
import {
  createStarsAdapter,
  rubToStars,
  DEFAULT_RUB_PER_STAR,
  type StarsEnv,
  type SuccessfulPayment,
} from '../src/index';

const silent = () => {};

function liveEnv(over: Partial<StarsEnv> = {}): StarsEnv {
  return { TG_BOT_TOKEN: 'test-token', ...over };
}

describe('createStarsAdapter — mode resolution', () => {
  it('defaults to stub when TG_BOT_TOKEN is empty', () => {
    const a = createStarsAdapter({}, { log: silent });
    expect(a.mode).toBe('stub');
  });

  it('is live when TG_BOT_TOKEN is set', () => {
    const a = createStarsAdapter(liveEnv(), { log: silent });
    expect(a.mode).toBe('live');
  });

  it('TG_STARS_MODE=stub forces stub even with a token present', () => {
    const a = createStarsAdapter(liveEnv({ TG_STARS_MODE: 'stub' }), { log: silent });
    expect(a.mode).toBe('stub');
  });
});

describe('stub adapter — createInvoice', () => {
  it('returns a synthetic invoice link carrying the payload + stars', async () => {
    const a = createStarsAdapter({}, { log: silent });
    const res = await a.createInvoice({
      orderId: 'ord_123',
      userId: 'u1',
      itemId: 'pack-200',
      title: 'Стартовый',
      description: '200 кредитов',
      amountStars: 111,
    });
    expect(res.payload).toBe('ord_123');
    expect(res.amountStars).toBe(111);
    expect(res.invoiceLink).toContain('payload=ord_123');
    expect(res.invoiceLink).toContain('stars=111');
  });

  it('rejects a non-positive-integer star amount', async () => {
    const a = createStarsAdapter({}, { log: silent });
    await expect(
      a.createInvoice({
        orderId: 'o',
        userId: 'u',
        itemId: 'p',
        title: 't',
        description: 'd',
        amountStars: 0,
      }),
    ).rejects.toThrow(/positive integer/);
  });
});

describe('live adapter — createInvoice posts XTR invoice to the Bot API', () => {
  it('calls createInvoiceLink with currency XTR + the order id as payload', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: 'https://t.me/$abc' }), { status: 200 }),
    );
    const a = createStarsAdapter(liveEnv({ TG_API_BASE_URL: 'https://tg.test' }), {
      fetch: fetchMock as unknown as typeof fetch,
      log: silent,
    });
    const res = await a.createInvoice({
      orderId: 'ord_777',
      userId: 'u1',
      itemId: 'pack-1000',
      title: 'Стандарт',
      description: '1000 кредитов',
      amountStars: 500,
    });
    expect(res.invoiceLink).toBe('https://t.me/$abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://tg.test/bottest-token/createInvoiceLink');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.currency).toBe('XTR');
    expect(body.payload).toBe('ord_777');
    expect(body.prices).toEqual([{ label: 'Стандарт', amount: 500 }]);
  });

  it('throws when the Bot API returns a non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 400 }));
    const a = createStarsAdapter(liveEnv(), {
      fetch: fetchMock as unknown as typeof fetch,
      log: silent,
    });
    await expect(
      a.createInvoice({
        orderId: 'o',
        userId: 'u',
        itemId: 'p',
        title: 't',
        description: 'd',
        amountStars: 10,
      }),
    ).rejects.toThrow(/createInvoiceLink failed: 400/);
  });

  it('throws when the Bot API returns ok:false', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'BOT_BLOCKED' }), { status: 200 }),
    );
    const a = createStarsAdapter(liveEnv(), {
      fetch: fetchMock as unknown as typeof fetch,
      log: silent,
    });
    await expect(
      a.createInvoice({
        orderId: 'o',
        userId: 'u',
        itemId: 'p',
        title: 't',
        description: 'd',
        amountStars: 10,
      }),
    ).rejects.toThrow(/BOT_BLOCKED/);
  });
});

describe('parseSuccessfulPayment', () => {
  const base: SuccessfulPayment = {
    currency: 'XTR',
    total_amount: 500,
    invoice_payload: 'ord_777',
    telegram_payment_charge_id: 'chg_abc',
  };

  it('accepts a well-formed XTR payment and extracts charge id + payload', () => {
    const a = createStarsAdapter({}, { log: silent });
    const r = a.parseSuccessfulPayment(base);
    expect(r.ok).toBe(true);
    expect(r.chargeId).toBe('chg_abc');
    expect(r.payload).toBe('ord_777');
    expect(r.amountStars).toBe(500);
  });

  it('rejects a non-XTR currency', () => {
    const a = createStarsAdapter({}, { log: silent });
    const r = a.parseSuccessfulPayment({ ...base, currency: 'RUB' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_stars');
  });

  it('rejects a payment missing the charge id', () => {
    const a = createStarsAdapter({}, { log: silent });
    const r = a.parseSuccessfulPayment({ ...base, telegram_payment_charge_id: undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing_charge_id');
  });

  it('rejects a payment missing the invoice payload', () => {
    const a = createStarsAdapter({}, { log: silent });
    const r = a.parseSuccessfulPayment({ ...base, invoice_payload: undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing_payload');
  });
});

describe('rubToStars', () => {
  it('converts roubles to whole Stars at the default rate', () => {
    // 199 / 1.8 = 110.5 → 111
    expect(rubToStars(199)).toBe(111);
    // 899 / 1.8 = 499.4 → 499
    expect(rubToStars(899)).toBe(499);
    // 3990 / 1.8 = 2216.7 → 2217
    expect(rubToStars(3990)).toBe(2217);
  });

  it('honours a custom rate', () => {
    expect(rubToStars(100, 2)).toBe(50);
  });

  it('never returns less than 1 Star', () => {
    expect(rubToStars(1, 1000)).toBe(1);
  });

  it('rejects invalid input', () => {
    expect(() => rubToStars(0)).toThrow();
    expect(() => rubToStars(100, 0)).toThrow();
  });

  it('exposes the default rate constant', () => {
    expect(DEFAULT_RUB_PER_STAR).toBe(1.8);
  });
});
