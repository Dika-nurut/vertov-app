import { timingSafeEqual } from 'node:crypto';

export type YooKassaMode = 'stub' | 'live';

export type PaymentKind = 'pack' | 'subscription';

export interface CreatePaymentInput {
  /** Amount in whole roubles. The adapter formats `"N.00"` for ЮKassa. */
  amountRub: number;
  /** Our internal order id — also used as Idempotence-Key. */
  orderId: string;
  /** Owning user id (recorded in payment metadata). */
  userId: string;
  /** Pack id or subscription tier id (recorded in payment metadata). */
  itemId: string;
  /** 'pack' or 'subscription' — used in description + metadata. */
  kind: PaymentKind;
  /** Where ЮKassa redirects the buyer after confirmation. */
  returnUrl: string;
  /** Human-readable line on the ЮKassa hosted page. */
  description: string;
  /**
   * Buyer email for the 54-ФЗ fiscal receipt (чек). When present (and a
   * shop id/secret are configured), the adapter attaches a `receipt` so
   * ЮKassa issues the чек on capture. ЮKassa requires an email *or* phone
   * to fiscalise; when neither is on file the receipt is omitted.
   */
  customerEmail?: string | null;
  /**
   * Buyer phone (E.164) — used for the 54-ФЗ receipt when no email is on
   * file (e.g. phone-OTP signups). Email is preferred when both exist.
   */
  customerPhone?: string | null;
  /**
   * Short line-item label for the receipt (≤128 chars per 54-ФЗ).
   * Defaults to `description` when absent.
   */
  receiptDescription?: string;
}

export interface CreatePaymentResult {
  confirmationUrl: string;
  providerPaymentId: string;
  status: string;
}

export interface VerifyWebhookInput {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifyWebhookResult {
  ok: boolean;
  reason?: 'missing_secret_prod' | 'bad_header' | 'length_mismatch' | 'mismatch';
}

/** What the provider says about a payment we already created. */
export interface RetrievedPayment {
  providerPaymentId: string;
  status: string;
  /**
   * Amount in whole roubles, or `null` when the adapter cannot assert it (the
   * stub). A null amount means "not verified" — callers must treat it as an
   * absent check, never as a match.
   */
  amountRub: number | null;
}

/**
 * Did the create definitely NOT produce a payment, or do we simply not know?
 *
 * This distinction is load-bearing for money. `rejected` means the provider
 * refused the request outright, so no payment exists and the local intent may be
 * released. `unknown` covers a timeout, an aborted socket, a 5xx, or a success
 * body we could not parse — in every one of those a payment MAY exist at
 * YooKassa, so releasing the intent would let the customer create a second real
 * payment for the same purchase.
 */
export type CreateFailureOutcome = 'rejected' | 'unknown';

export class PaymentCreateError extends Error {
  constructor(
    message: string,
    public readonly outcome: CreateFailureOutcome,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PaymentCreateError';
  }
}

/**
 * Statuses that prove the request was refused before a payment could exist.
 * Deliberately a small allow-list: anything not named here is `unknown`, so a
 * status we have not reasoned about fails safe. 409 is excluded on purpose —
 * ЮKassa uses it for idempotency-key conflicts, which means a payment probably
 * DOES exist. 408/429 are excluded because the request may still have landed.
 */
const DEFINITE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422]);

export function createFailureOutcome(status: number): CreateFailureOutcome {
  return DEFINITE_REJECTION_STATUSES.has(status) ? 'rejected' : 'unknown';
}

export interface YooKassaAdapter {
  mode: YooKassaMode;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /**
   * Read a payment back from the provider. Used to verify a webhook we could
   * only attribute through our own `metadata.orderId` — an authenticated
   * request body is not by itself proof that money moved.
   *
   * Returns `null` when the provider does not know the payment. THROWS when the
   * lookup itself failed (network, 5xx): callers must not read a throw as
   * "no payment", only as "unknown".
   */
  retrievePayment(providerPaymentId: string): Promise<RetrievedPayment | null>;
  verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult;
}

export interface YooKassaEnv {
  YOOKASSA_MODE?: string;
  YOOKASSA_SHOP_ID?: string;
  YOOKASSA_SECRET_KEY?: string;
  YOOKASSA_WEBHOOK_SECRET?: string;
  YOOKASSA_BASE_URL?: string;
  /** 54-ФЗ ставка НДС. 1 = без НДС (default — мы на УСН). */
  YOOKASSA_VAT_CODE?: string;
  /**
   * 54-ФЗ система налогообложения. 2 = УСН доход, 3 = УСН доход-расход.
   * Default 2; owner confirms the УСН variant before paid launch (M-19).
   */
  YOOKASSA_TAX_SYSTEM_CODE?: string;
  NODE_ENV?: string;
}

export interface AdapterDeps {
  /** Override for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional logger; defaults to console for adapter construction. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

function resolveMode(env: YooKassaEnv): YooKassaMode {
  const explicit = (env.YOOKASSA_MODE ?? '').toLowerCase();
  if (explicit === 'stub') return 'stub';
  if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) return 'stub';
  return 'live';
}

/**
 * Construct a ЮKassa adapter. The same construction site is used in api
 * (checkout/subscription) and worker (subscription cycle renewals) so the
 * mode decision is centralised here.
 */
export function createYooKassaAdapter(
  env: YooKassaEnv = process.env as YooKassaEnv,
  deps: AdapterDeps = {},
): YooKassaAdapter {
  const mode = resolveMode(env);
  const log = deps.log ?? ((msg, meta) => console.log(`[yookassa] ${msg}`, meta ?? {}));
  log(`adapter constructed mode=${mode}`);
  if (mode === 'stub') return createStubAdapter();
  return createLiveAdapter(env, deps);
}

function createStubAdapter(): YooKassaAdapter {
  return {
    mode: 'stub',
    async createPayment(input) {
      const providerPaymentId = `stub-${input.orderId}`;
      const sep = input.returnUrl.includes('?') ? '&' : '?';
      return {
        confirmationUrl: `${input.returnUrl}${sep}forceSuccess=1`,
        providerPaymentId,
        status: 'pending',
      };
    },
    // The stub has no provider to ask. It confirms the status the caller is
    // acting on but asserts NO amount, so the amount check is skipped rather
    // than faked. Stub mode is refused in production, so this cannot weaken a
    // live settlement.
    async retrievePayment(providerPaymentId) {
      return { providerPaymentId, status: 'succeeded', amountRub: null };
    },
    verifyWebhook: makeBearerVerifier(),
  };
}

/**
 * Build the 54-ФЗ `receipt` object so ЮKassa fiscalises the sale on
 * capture. Returns `undefined` when there's no buyer email/phone to send
 * the чек to (ЮKassa rejects a receipt without a contact). All sales are
 * single-line, full-payment digital services; tax codes come from env so
 * the УСН variant can be flipped without a deploy.
 */
export function buildReceipt(
  env: YooKassaEnv,
  input: CreatePaymentInput,
): Record<string, unknown> | undefined {
  const email = input.customerEmail?.trim();
  const phone = input.customerPhone?.trim();
  // ЮKassa needs a contact to fiscalise. Prefer email; fall back to phone.
  const customer = email ? { email } : phone ? { phone } : undefined;
  if (!customer) return undefined;
  const vatCode = Number(env.YOOKASSA_VAT_CODE ?? '1');
  const taxSystemCode = Number(env.YOOKASSA_TAX_SYSTEM_CODE ?? '2');
  const label = (input.receiptDescription ?? input.description).slice(0, 128);
  return {
    customer,
    tax_system_code: taxSystemCode,
    items: [
      {
        description: label,
        quantity: '1.00',
        amount: { value: `${input.amountRub}.00`, currency: 'RUB' },
        vat_code: vatCode,
        payment_mode: 'full_payment',
        payment_subject: 'service',
      },
    ],
  };
}

function createLiveAdapter(env: YooKassaEnv, deps: AdapterDeps): YooKassaAdapter {
  const shopId = env.YOOKASSA_SHOP_ID!;
  const secret = env.YOOKASSA_SECRET_KEY!;
  const base = env.YOOKASSA_BASE_URL ?? 'https://api.yookassa.ru/v3';
  const fetchImpl = deps.fetch ?? fetch;
  const basic = Buffer.from(`${shopId}:${secret}`).toString('base64');
  return {
    mode: 'live',
    async createPayment(input) {
      // #13 audit: 30-second timeout so a hung ЮKassa endpoint doesn't
      // block the Node event loop indefinitely. AbortSignal.timeout is
      // available in Node 18+ and has no extra dependencies.
      const receipt = buildReceipt(env, input);
      let res: Response;
      try {
        res = await fetchImpl(`${base}/payments`, {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Basic ${basic}`,
            'Idempotence-Key': input.orderId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: { value: `${input.amountRub}.00`, currency: 'RUB' },
            capture: true,
            confirmation: { type: 'redirect', return_url: input.returnUrl },
            description: input.description,
            // 54-ФЗ чек: present only when we have a buyer contact to send it to.
            ...(receipt ? { receipt } : {}),
            metadata: {
              orderId: input.orderId,
              userId: input.userId,
              itemId: input.itemId,
              kind: input.kind,
            },
          }),
        });
      } catch (err) {
        // Timeout / aborted socket / DNS: the request may well have reached
        // ЮKassa and created the payment. Never treat this as "no payment".
        throw new PaymentCreateError(
          `yookassa payment create unreachable: ${(err as Error).message}`,
          'unknown',
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new PaymentCreateError(
          `yookassa payment create failed: ${res.status} ${body.slice(0, 200)}`,
          createFailureOutcome(res.status),
          res.status,
        );
      }
      let data: {
        id: string;
        status: string;
        confirmation?: { type: string; confirmation_url?: string };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch (err) {
        // A 2xx we could not parse means the payment almost certainly EXISTS.
        throw new PaymentCreateError(
          `yookassa payment create unparseable: ${(err as Error).message}`,
          'unknown',
        );
      }
      const confirmationUrl = data.confirmation?.confirmation_url;
      // The provider answered 2xx, so a payment exists even though we cannot
      // hand the buyer a link — `unknown`, so the intent stays claimed.
      if (!confirmationUrl)
        throw new PaymentCreateError('yookassa: missing confirmation_url', 'unknown');
      return { confirmationUrl, providerPaymentId: data.id, status: data.status };
    },
    async retrievePayment(providerPaymentId) {
      const res = await fetchImpl(`${base}/payments/${encodeURIComponent(providerPaymentId)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${basic}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`yookassa payment retrieve failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        id: string;
        status: string;
        amount?: { value?: string | number };
      };
      const raw = data.amount?.value;
      const amountRub = raw == null ? null : Number(raw);
      return {
        providerPaymentId: data.id,
        status: data.status,
        amountRub: Number.isFinite(amountRub) ? (amountRub as number) : null,
      };
    },
    verifyWebhook: makeBearerVerifier(),
  };
}

/**
 * ЮKassa does not sign webhook bodies in their default integration; the
 * documented pattern is a custom header set in the dashboard. We use
 * `Authorization: Bearer <YOOKASSA_WEBHOOK_SECRET>` with constant-time
 * comparison. In production a missing secret means *refuse all webhooks*;
 * in dev/test, missing secret means accept (so test harnesses can fire
 * webhooks without dashboard setup).
 */
function makeBearerVerifier(): YooKassaAdapter['verifyWebhook'] {
  return (input) => {
    const secret = process.env.YOOKASSA_WEBHOOK_SECRET;
    const isProd = process.env.NODE_ENV === 'production';
    if (!secret) {
      if (isProd) return { ok: false, reason: 'missing_secret_prod' };
      return { ok: true };
    }
    const raw = input.headers['authorization'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return { ok: false, reason: 'bad_header' };
    }
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(secret);
    if (provided.length !== expected.length) return { ok: false, reason: 'length_mismatch' };
    return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
  };
}
