/**
 * @seed/provider-stars — Telegram Stars (XTR) payment adapter.
 *
 * Mirrors the @seed/provider-yookassa shape: a single `createStarsAdapter(env, deps)`
 * factory that returns a stub or live implementation based on env. The mode decision
 * is centralised here so the bot (apps/bot) constructs it the same way the api/worker
 * construct the ЮKassa adapter.
 *
 * Unlike a card PSP, Stars settles *inside* Telegram:
 *   1. We create an invoice link (`createInvoiceLink`, currency `XTR`) carrying our
 *      order id as the `invoice_payload`.
 *   2. The user pays inside Telegram. Telegram fires `pre_checkout_query` (the bot
 *      answers ok) then delivers a `message.successful_payment`.
 *   3. `successful_payment.telegram_payment_charge_id` is the unique provider id we
 *      store on the order (`orders.psp = 'stars'`, `pspPaymentId = chargeId`) and use
 *      to drive an idempotent credit grant (`stars:<chargeId>`).
 *
 * Stub mode (no TG_BOT_TOKEN) returns a synthetic invoice link and lets a test/dev
 * harness fabricate a `successful_payment` so the buy→grant flow runs end-to-end
 * without a real bot token — same philosophy as the ЮKassa `?forceSuccess=1` stub.
 */

export type StarsMode = 'stub' | 'live';

export interface CreateInvoiceInput {
  /** Our internal order id — carried verbatim as the Telegram `invoice_payload`. */
  orderId: string;
  /** Owning user id (for logging/correlation; not sent to Telegram). */
  userId: string;
  /** Pack id or item id (for logging/correlation). */
  itemId: string;
  /** Invoice title shown in the Telegram pay sheet (RU copy). */
  title: string;
  /** Invoice description shown in the Telegram pay sheet (RU copy). */
  description: string;
  /** Price in whole Telegram Stars (XTR). Must be a positive integer. */
  amountStars: number;
}

export interface CreateInvoiceResult {
  /** A `https://t.me/...` invoice link the bot sends to the user. */
  invoiceLink: string;
  /** Echo of the order id we set as `invoice_payload`. */
  payload: string;
  amountStars: number;
}

/**
 * The subset of Telegram's `SuccessfulPayment` object we rely on. Kept structural
 * (snake_case) so a raw Bot API update can be passed straight in.
 */
export interface SuccessfulPayment {
  currency?: string;
  total_amount?: number;
  invoice_payload?: string;
  telegram_payment_charge_id?: string;
  provider_payment_charge_id?: string;
}

export interface ParsePaymentResult {
  ok: boolean;
  /** `telegram_payment_charge_id` — unique; becomes `orders.pspPaymentId`. */
  chargeId?: string;
  /** `invoice_payload` — our order id. */
  payload?: string;
  /** Stars actually charged (`total_amount`, XTR has no minor units). */
  amountStars?: number;
  reason?: 'not_stars' | 'missing_charge_id' | 'missing_payload';
}

export interface StarsAdapter {
  mode: StarsMode;
  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
  /** Validate + extract the fields we need from a `successful_payment` update. */
  parseSuccessfulPayment(sp: SuccessfulPayment): ParsePaymentResult;
}

export interface StarsEnv {
  TG_STARS_MODE?: string;
  TG_BOT_TOKEN?: string;
  /** Override the Bot API base (tests/self-hosted). Defaults to api.telegram.org. */
  TG_API_BASE_URL?: string;
  /** RUB→Stars conversion rate (roubles per Star). Defaults to 1.8 (May 2026). */
  TG_STARS_RUB_PER_STAR?: string;
  NODE_ENV?: string;
}

export interface AdapterDeps {
  /** Override for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional logger; defaults to console for adapter construction. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Default roubles-per-Star used when `TG_STARS_RUB_PER_STAR` is unset. */
export const DEFAULT_RUB_PER_STAR = 1.8;

/**
 * Convert a rouble price to whole Telegram Stars, rounding to the nearest Star
 * (minimum 1). Pricing lives in RUB everywhere else (orders.amountRub, the credit
 * pack catalogue); we only convert at invoice time.
 */
export function rubToStars(amountRub: number, rubPerStar: number = DEFAULT_RUB_PER_STAR): number {
  if (!Number.isFinite(amountRub) || amountRub <= 0) {
    throw new Error(`rubToStars: invalid amountRub ${amountRub}`);
  }
  if (!Number.isFinite(rubPerStar) || rubPerStar <= 0) {
    throw new Error(`rubToStars: invalid rubPerStar ${rubPerStar}`);
  }
  return Math.max(1, Math.round(amountRub / rubPerStar));
}

function resolveMode(env: StarsEnv): StarsMode {
  const explicit = (env.TG_STARS_MODE ?? '').toLowerCase();
  if (explicit === 'stub') return 'stub';
  if (!env.TG_BOT_TOKEN) return 'stub';
  return 'live';
}

function parseSuccessfulPayment(sp: SuccessfulPayment): ParsePaymentResult {
  if ((sp.currency ?? '').toUpperCase() !== 'XTR') {
    return { ok: false, reason: 'not_stars' };
  }
  if (!sp.telegram_payment_charge_id) {
    return { ok: false, reason: 'missing_charge_id' };
  }
  if (!sp.invoice_payload) {
    return { ok: false, reason: 'missing_payload' };
  }
  return {
    ok: true,
    chargeId: sp.telegram_payment_charge_id,
    payload: sp.invoice_payload,
    // exactOptionalPropertyTypes: omit the key entirely rather than set undefined.
    ...(sp.total_amount !== undefined ? { amountStars: sp.total_amount } : {}),
  };
}

function assertPositiveIntStars(amountStars: number): void {
  if (!Number.isInteger(amountStars) || amountStars <= 0) {
    throw new Error(`stars: amountStars must be a positive integer, got ${amountStars}`);
  }
}

/**
 * Construct a Telegram Stars adapter. Same construction contract as
 * `createYooKassaAdapter`: defaults to `process.env`, accepts an injectable
 * `fetch`/`log` for tests.
 */
export function createStarsAdapter(
  env: StarsEnv = process.env as StarsEnv,
  deps: AdapterDeps = {},
): StarsAdapter {
  const mode = resolveMode(env);
  const log = deps.log ?? ((msg, meta) => console.log(`[stars] ${msg}`, meta ?? {}));
  log(`adapter constructed mode=${mode}`);
  if (mode === 'stub') return createStubAdapter();
  return createLiveAdapter(env, deps);
}

function createStubAdapter(): StarsAdapter {
  return {
    mode: 'stub',
    async createInvoice(input) {
      assertPositiveIntStars(input.amountStars);
      // Synthetic invoice link carrying the payload + amount so a dev/test harness
      // can fabricate the matching successful_payment without a real bot token.
      const link =
        `https://t.me/invoice/stub?payload=${encodeURIComponent(input.orderId)}` +
        `&stars=${input.amountStars}`;
      return { invoiceLink: link, payload: input.orderId, amountStars: input.amountStars };
    },
    parseSuccessfulPayment,
  };
}

function createLiveAdapter(env: StarsEnv, deps: AdapterDeps): StarsAdapter {
  const token = env.TG_BOT_TOKEN!;
  const base = env.TG_API_BASE_URL ?? 'https://api.telegram.org';
  const fetchImpl = deps.fetch ?? fetch;
  return {
    mode: 'live',
    async createInvoice(input) {
      assertPositiveIntStars(input.amountStars);
      // createInvoiceLink with currency XTR; `prices[].amount` for XTR is the
      // number of Stars directly (no *100 minor-unit scaling like fiat).
      const res = await fetchImpl(`${base}/bot${token}/createInvoiceLink`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          payload: input.orderId,
          currency: 'XTR',
          prices: [{ label: input.title, amount: input.amountStars }],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`stars createInvoiceLink failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { ok: boolean; result?: string; description?: string };
      if (!data.ok || !data.result) {
        throw new Error(`stars createInvoiceLink not ok: ${data.description ?? 'unknown'}`);
      }
      return { invoiceLink: data.result, payload: input.orderId, amountStars: input.amountStars };
    },
    parseSuccessfulPayment,
  };
}
