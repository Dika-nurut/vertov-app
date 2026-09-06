import { readFileSync } from 'node:fs';
import { importJWK, jwtVerify, type JWK, type JWTPayload } from 'jose';
import { Agent, type Dispatcher } from 'undici';

export type TochkaMode = 'sandbox' | 'live';
export type TochkaPaymentKind = 'pack' | 'subscription';

export interface TochkaEnv {
  TOCHKA_MODE?: string;
  TOCHKA_JWT?: string;
  /** Optional provider-scoped CA bundle for Tochka's Russian TLS chain. */
  TOCHKA_CA_CERT?: string;
  TOCHKA_BASE_URL?: string;
  TOCHKA_CUSTOMER_CODE?: string;
  TOCHKA_MERCHANT_ID?: string;
  TOCHKA_CLIENT_ID?: string;
  TOCHKA_PUBLIC_KEY_URL?: string;
  TOCHKA_WEBHOOK_PUBLIC_KEY?: string;
  TOCHKA_USE_RECEIPTS?: string;
  TOCHKA_TAX_SYSTEM_CODE?: string;
  TOCHKA_VAT_TYPE?: string;
  TOCHKA_SUBSCRIPTION_TRANCHE_COUNT?: string;
  TOCHKA_SUBSCRIPTION_PERIOD?: string;
  TOCHKA_PAYMENT_MODES?: string;
  NODE_ENV?: string;
}

export interface TochkaDeps {
  fetch?: typeof fetch;
  /** Avoid a network request in tests; production defaults to console. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface CreatePaymentInput {
  amountRub: number;
  orderId: string;
  kind: TochkaPaymentKind;
  purpose: string;
  returnUrl: string;
  failReturnUrl?: string;
  customerEmail?: string | null | undefined;
  customerPhone?: string | null | undefined;
  itemTitle: string;
  preAuthorization?: boolean;
}

export interface CreatePaymentResult {
  confirmationUrl: string;
  providerPaymentId: string;
  status: string;
  paymentLinkId: string;
}

export interface CreateSubscriptionInput {
  amountRub: number;
  orderId: string;
  purpose: string;
  returnUrl: string;
  failReturnUrl?: string;
  customerEmail?: string | null | undefined;
  customerPhone?: string | null | undefined;
  itemTitle: string;
}

export interface CreateSubscriptionResult {
  confirmationUrl: string;
  providerSubscriptionId: string;
  consumerId?: string;
  status: string;
  paymentLinkId: string;
}

export interface ChargeSubscriptionInput {
  subscriptionId: string;
  amountRub: number;
  purpose: string;
  paymentLinkId: string;
  customerEmail?: string | null | undefined;
  customerPhone?: string | null | undefined;
  itemTitle: string;
}

export interface TochkaPaymentProvider {
  readonly mode: TochkaMode;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult>;
  chargeSubscription(
    input: ChargeSubscriptionInput,
  ): Promise<{ paymentId: string; status: string }>;
  getCustomers(): Promise<Record<string, unknown>>;
  getRetailers(): Promise<Record<string, unknown>>;
  getPaymentOperationList(fromDate: string, toDate: string): Promise<Record<string, unknown>>;
  getPaymentInfo(operationId: string): Promise<Record<string, unknown>>;
  /** `refundUid` is the provider-side idempotency key for a refund request. */
  refundPayment(
    operationId: string,
    amountRub: number | undefined,
    refundUid: string,
  ): Promise<Record<string, unknown>>;
  getPaymentRegistry(date: string): Promise<Record<string, unknown>>;
  setSubscriptionStatus(operationId: string, status: 'Active' | 'Cancelled'): Promise<void>;
  getSubscriptionStatus(operationId: string): Promise<Record<string, unknown>>;
  verifyWebhook(input: { rawBody: string }): Promise<TochkaWebhookVerification>;
}

export interface TochkaWebhookVerification {
  ok: boolean;
  reason?: 'missing_key' | 'invalid_jwt' | 'wrong_event';
  payload?: JWTPayload & Record<string, unknown>;
}

type OperationEnvelope = {
  Data?: Record<string, unknown> & { Operation?: Array<Record<string, unknown>> };
};

const SANDBOX_URL = 'https://enter.tochka.com/sandbox/v2';
const LIVE_URL = 'https://enter.tochka.com/uapi';

let cachedCa: { path: string; dispatcher: Dispatcher } | null = null;

function tochkaDispatcher(env: TochkaEnv): Dispatcher | undefined {
  const caPath = env.TOCHKA_CA_CERT?.trim();
  if (!caPath) return undefined;
  if (cachedCa?.path === caPath) return cachedCa.dispatcher;

  let ca: string;
  try {
    ca = readFileSync(caPath, 'utf8');
  } catch (error) {
    throw new Error(
      `tochka: TOCHKA_CA_CERT is unreadable at ${caPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const dispatcher = new Agent({ connect: { ca } });
  cachedCa = { path: caPath, dispatcher };
  return dispatcher;
}

function resolveMode(env: TochkaEnv): TochkaMode {
  return (env.TOCHKA_MODE ?? '').toLowerCase() === 'sandbox' ? 'sandbox' : 'live';
}

function amount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error('tochka: amount must be positive');
  return value.toFixed(2);
}

function firstOperation(data: unknown): Record<string, unknown> {
  const body = (data as OperationEnvelope)?.Data;
  const operation = body?.Operation?.[0] ?? body;
  if (!operation) throw new Error('tochka: response did not contain Data.Operation[0]');
  return operation;
}

function stringField(operation: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = operation[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function receiptFields(
  env: TochkaEnv,
  input: {
    itemTitle: string;
    amountRub: number;
    email?: string | null | undefined;
    phone?: string | null | undefined;
  },
) {
  const client = input.email?.trim()
    ? { email: input.email.trim() }
    : input.phone?.trim()
      ? { phone: input.phone.trim() }
      : undefined;
  if (!client) return {};
  return {
    Client: client,
    Items: [
      {
        name: input.itemTitle.slice(0, 128),
        amount: amount(input.amountRub),
        quantity: '1',
        vatType: env.TOCHKA_VAT_TYPE ?? 'none',
        paymentMethod: 'full_payment',
        paymentObject: 'service',
        measure: 'шт.',
      },
    ],
    taxSystemCode: env.TOCHKA_TAX_SYSTEM_CODE || undefined,
  };
}

function hasReceipts(env: TochkaEnv): boolean {
  return (env.TOCHKA_USE_RECEIPTS ?? '').toLowerCase() === 'true';
}

function paymentModes(env: TochkaEnv): string[] {
  const configured = env.TOCHKA_PAYMENT_MODES?.split(',')
    .map((mode) => mode.trim())
    .filter(Boolean);
  return configured?.length ? configured : ['card', 'sbp'];
}

export function createTochkaProvider(
  env: TochkaEnv = process.env as TochkaEnv,
  deps: TochkaDeps = {},
): TochkaPaymentProvider {
  const mode = resolveMode(env);
  const token = mode === 'sandbox' ? 'sandbox.jwt.token' : env.TOCHKA_JWT;
  const baseUrl = env.TOCHKA_BASE_URL ?? (mode === 'sandbox' ? SANDBOX_URL : LIVE_URL);
  const fetchImpl = deps.fetch ?? fetch;
  const dispatcher = tochkaDispatcher(env);
  const log = deps.log ?? ((message, meta) => console.log(`[tochka] ${message}`, meta ?? {}));
  log(`adapter constructed mode=${mode}`);
  let publicKeyPromise: Promise<JWK | null> | null = null;

  async function request(
    path: string,
    init: { method: string; body?: unknown; headers?: Record<string, string> } = { method: 'GET' },
  ): Promise<unknown> {
    if (!token) throw new Error('tochka: TOCHKA_JWT is required in live mode');
    const requestInit = {
      method: init.method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher };
    const response = await fetchImpl(`${baseUrl}${path}`, requestInit);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `tochka ${init.method} ${path} failed: ${response.status} ${body.slice(0, 300)}`,
      );
    }
    return response.json();
  }

  function commonOperation(input: CreatePaymentInput | CreateSubscriptionInput) {
    return {
      amount: amount(input.amountRub),
      customerCode: env.TOCHKA_CUSTOMER_CODE,
      purpose: input.purpose,
      redirectUrl: input.returnUrl,
      failRedirectUrl: input.failReturnUrl ?? input.returnUrl,
      merchantId: env.TOCHKA_MERCHANT_ID,
      paymentLinkId: input.orderId,
    };
  }

  async function createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const operation = {
      ...commonOperation(input),
      paymentMode: paymentModes(env),
      ...(input.preAuthorization ? { preAuthorization: true } : {}),
      ...(hasReceipts(env)
        ? receiptFields(env, {
            itemTitle: input.itemTitle,
            amountRub: input.amountRub,
            email: input.customerEmail,
            phone: input.customerPhone,
          })
        : {}),
    };
    const path = hasReceipts(env)
      ? '/acquiring/v1.0/payments_with_receipt'
      : '/acquiring/v1.0/payments';
    const response = await request(path, {
      method: 'POST',
      body: { Data: operation },
    });
    const op = firstOperation(response);
    const confirmationUrl = stringField(
      op,
      'paymentLink',
      'redirectUrl',
      'paymentUrl',
      'confirmationUrl',
    );
    const providerPaymentId = stringField(op, 'operationId', 'id');
    if (!confirmationUrl || !providerPaymentId)
      throw new Error('tochka: payment response missing operationId or redirectUrl');
    return {
      confirmationUrl,
      providerPaymentId,
      paymentLinkId: stringField(op, 'paymentLinkId') ?? input.orderId,
      status: stringField(op, 'status') ?? 'CREATED',
    };
  }

  async function createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<CreateSubscriptionResult> {
    const operation = {
      ...commonOperation(input),
      paymentMode: ['card'],
      saveCard: true,
      Options: {
        trancheCount: Number(env.TOCHKA_SUBSCRIPTION_TRANCHE_COUNT ?? '84'),
        period: env.TOCHKA_SUBSCRIPTION_PERIOD ?? 'Month',
      },
      ...(hasReceipts(env)
        ? receiptFields(env, {
            itemTitle: input.itemTitle,
            amountRub: input.amountRub,
            email: input.customerEmail,
            phone: input.customerPhone,
          })
        : {}),
    };
    const path = hasReceipts(env)
      ? '/acquiring/v1.0/subscriptions_with_receipt'
      : '/acquiring/v1.0/subscriptions';
    const response = await request(path, {
      method: 'POST',
      body: { Data: operation },
    });
    const op = firstOperation(response);
    const confirmationUrl = stringField(
      op,
      'paymentLink',
      'redirectUrl',
      'paymentUrl',
      'confirmationUrl',
    );
    const providerSubscriptionId = stringField(op, 'operationId', 'id');
    if (!confirmationUrl || !providerSubscriptionId)
      throw new Error('tochka: subscription response missing operationId or redirectUrl');
    const consumerId = stringField(op, 'consumerId');
    return {
      confirmationUrl,
      providerSubscriptionId,
      paymentLinkId: stringField(op, 'paymentLinkId') ?? input.orderId,
      status: stringField(op, 'status') ?? 'CREATED',
      ...(consumerId ? { consumerId } : {}),
    };
  }

  async function chargeSubscription(input: ChargeSubscriptionInput) {
    const response = await request(
      `/acquiring/v1.0/subscriptions/${encodeURIComponent(input.subscriptionId)}/charge`,
      {
        method: 'POST',
        body: {
          Data: {
            amount: amount(input.amountRub),
            customerCode: env.TOCHKA_CUSTOMER_CODE,
            purpose: input.purpose,
            paymentMode: ['card'],
            paymentLinkId: input.paymentLinkId,
            ...(hasReceipts(env)
              ? receiptFields(env, {
                  itemTitle: input.itemTitle,
                  amountRub: input.amountRub,
                  email: input.customerEmail,
                  phone: input.customerPhone,
                })
              : {}),
          },
        },
      },
    );
    const op = firstOperation(response);
    const paymentId = stringField(op, 'operationId', 'id');
    if (!paymentId) throw new Error('tochka: subscription charge response missing operationId');
    return {
      // Never substitute our local paymentLinkId here. If Tochka accepted the
      // charge but the response omitted its operation id, the signed webhook
      // must be able to bind the real PSP payment by paymentLinkId; a synthetic
      // local id would make that later binding look like a different payment.
      paymentId,
      status: stringField(op, 'status') ?? 'CREATED',
    };
  }

  async function verifyWebhook(input: { rawBody: string }): Promise<TochkaWebhookVerification> {
    try {
      if (!publicKeyPromise) {
        publicKeyPromise = (async () => {
          if (env.TOCHKA_WEBHOOK_PUBLIC_KEY)
            return JSON.parse(env.TOCHKA_WEBHOOK_PUBLIC_KEY) as JWK;
          const keyUrl = env.TOCHKA_PUBLIC_KEY_URL;
          if (!keyUrl) return null;
          const response = await fetchImpl(keyUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(10_000),
            headers: { Accept: 'application/json' },
            // The public-key URL is part of the same Tochka trust boundary as
            // the API calls. Use the provider-scoped Russian CA here too;
            // otherwise dynamic JWK retrieval fails with SELF_SIGNED_CERT_IN_CHAIN
            // even though payment requests themselves succeed.
            ...(dispatcher ? { dispatcher } : {}),
          } as RequestInit & { dispatcher?: Dispatcher });
          if (!response.ok) return null;
          const body = (await response.json()) as JWK | { keys?: JWK[] };
          if ('keys' in body) return body.keys?.[0] ?? null;
          return body as JWK;
        })();
      }
      const jwk = await publicKeyPromise;
      if (!jwk) return { ok: false, reason: 'missing_key' };
      const key = await importJWK(jwk, 'RS256');
      const verified = await jwtVerify(input.rawBody.trim(), key, { algorithms: ['RS256'] });
      if (verified.payload.event && verified.payload.event !== 'acquiringInternetPayment')
        return { ok: false, reason: 'wrong_event' };
      return { ok: true, payload: verified.payload as JWTPayload & Record<string, unknown> };
    } catch {
      return { ok: false, reason: 'invalid_jwt' };
    }
  }

  return {
    mode,
    createPayment,
    createSubscription,
    chargeSubscription,
    async getCustomers() {
      return (await request('/open-banking/v1.0/customers')) as Record<string, unknown>;
    },
    async getRetailers() {
      const params = new URLSearchParams({ customerCode: env.TOCHKA_CUSTOMER_CODE ?? '' });
      return (await request(`/acquiring/v1.0/retailers?${params.toString()}`)) as Record<
        string,
        unknown
      >;
    },
    async getPaymentOperationList(fromDate, toDate) {
      const params = new URLSearchParams({
        customerCode: env.TOCHKA_CUSTOMER_CODE ?? '',
        ...(env.TOCHKA_MERCHANT_ID ? { merchantId: env.TOCHKA_MERCHANT_ID } : {}),
        fromDate,
        toDate,
      });
      return (await request(`/acquiring/v1.0/payments?${params.toString()}`)) as Record<
        string,
        unknown
      >;
    },
    async getPaymentInfo(operationId) {
      return (await request(
        `/acquiring/v1.0/payments/${encodeURIComponent(operationId)}`,
      )) as Record<string, unknown>;
    },
    async refundPayment(operationId, amountRub, refundUid) {
      if (!refundUid || !/^[0-9A-Za-z-]{1,64}$/.test(refundUid)) {
        throw new Error(
          'tochka: refundUid is required and must be 1-64 ASCII letters, digits, or hyphens',
        );
      }
      const body = {
        Data: {
          refundUid,
          ...(amountRub === undefined ? {} : { amount: amount(amountRub) }),
        },
      };
      return (await request(`/acquiring/v1.0/payments/${encodeURIComponent(operationId)}/refund`, {
        method: 'POST',
        body,
      })) as Record<string, unknown>;
    },
    async getPaymentRegistry(date) {
      const params = new URLSearchParams({
        customerCode: env.TOCHKA_CUSTOMER_CODE ?? '',
        merchantId: env.TOCHKA_MERCHANT_ID ?? '',
        date,
      });
      return (await request(`/acquiring/v1.0/registry?${params.toString()}`)) as Record<
        string,
        unknown
      >;
    },
    async setSubscriptionStatus(operationId, status) {
      await request(`/acquiring/v1.0/subscriptions/${encodeURIComponent(operationId)}/status`, {
        method: 'POST',
        body: { Data: { status } },
      });
    },
    async getSubscriptionStatus(operationId) {
      return (await request(
        `/acquiring/v1.0/subscriptions/${encodeURIComponent(operationId)}/status`,
      )) as Record<string, unknown>;
    },
    verifyWebhook,
  };
}

export const _internal = { amount, firstOperation, resolveMode };
