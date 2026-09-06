import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  billingRefunds,
  billingUnresolvedEvents,
  creditPacks,
  db,
  galleryItems,
  hasPaidMediaStorage,
  lockMediaStorageUser,
  mediaExpiresAt,
  nid,
  orders,
  resolveLivePlanSubscription,
  subscriptions,
  subscriptionsCatalog,
  usersPii,
} from '@seed/db';
import { CreditService, WelcomeGrantService } from '@seed/credits';
import { createYooKassaAdapter, type YooKassaAdapter } from '@seed/provider-yookassa';
import { createTochkaProvider, type TochkaPaymentProvider } from '@seed/provider-tochka';
import {
  acquireBillingIntent,
  attachPspPayment,
  createFailureOutcomeOf,
  packIntentKey,
  releaseBillingIntent,
} from './billing-intent';
import {
  billingUnresolvedEventsTotal,
  creditsGrantTotal,
  freeGrantsIssuedTotal,
  freeGrantsRefusedTotal,
} from './metrics';
import { isAllowedWebhookIp, webhookIpAllowlist } from './webhook-ip';
import { isAdminUser } from './admin';

const WEB_PUBLIC_URL = process.env.WEB_PUBLIC_URL ?? 'http://127.0.0.1:3000';

const isProd = process.env.NODE_ENV === 'production';

const credits = new CreditService();
const welcome = new WelcomeGrantService({ credits });

/**
 * Free-token L3 — "first successful paid order". Idempotent per user (key
 * welcome:{userId}:L3); only enrolled users (have L0) qualify. Runs inside the
 * payment tx so it lands atomically with the purchase grant.
 *
 * NOTE (flagged gap): dedup is PER-USER only. The YooKassa webhook payload
 * exposes no stable payment-instrument id (card token / pan hash), so we cannot
 * bind L3 to a card to stop one card funding many accounts' L3 bonuses. If the
 * provider later surfaces payment_method.id, add an instrument-anchor table
 * mirroring free_phone_anchors.
 */
type BillingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function grantWelcomeL3(
  userId: string,
  tx: BillingTx,
  orderId: string,
  orderAmountRub: number,
): Promise<void> {
  const res = await welcome.grantL3({ userId, orderId, orderAmountRub, tx });
  if (res.granted) {
    creditsGrantTotal.labels('bonus_grant').inc(res.amount);
    freeGrantsIssuedTotal.labels('L3').inc();
  } else if (res.reason && res.reason !== 'already_granted') {
    freeGrantsRefusedTotal.labels('L3', res.reason).inc();
  }
}

let _adapter: YooKassaAdapter | null = null;
function getAdapter(): YooKassaAdapter {
  if (!_adapter) _adapter = createYooKassaAdapter();
  return _adapter;
}
/**
 * Test-only seam: install a fake adapter. This exists so the money path can be
 * fault-injected — a `createPayment` that fails AFTER the provider may have
 * created the payment is the case that decides whether a customer is charged
 * once or twice, and it cannot be reproduced against the stub.
 */
function _setAdapter(next: YooKassaAdapter | null): void {
  _adapter = next;
}

type ActivePaymentProvider =
  | { kind: 'yookassa'; adapter: YooKassaAdapter }
  | { kind: 'tochka'; adapter: TochkaPaymentProvider };

let _tochkaAdapter: TochkaPaymentProvider | null = null;
function getTochkaAdapter(): TochkaPaymentProvider {
  if (!_tochkaAdapter) _tochkaAdapter = createTochkaProvider();
  return _tochkaAdapter;
}

/** Test-only seam for the provider-specific metadata-fallback path. */
function _setTochkaAdapter(next: TochkaPaymentProvider | null): void {
  _tochkaAdapter = next;
}

function getPaymentProvider(): ActivePaymentProvider {
  if ((process.env.BILLING_PROVIDER ?? 'yookassa').toLowerCase() === 'tochka') {
    return { kind: 'tochka', adapter: getTochkaAdapter() };
  }
  return { kind: 'yookassa', adapter: getAdapter() };
}
/**
 * Buyer contact for the 54-ФЗ чек. Phone-OTP signups have a NULL email but
 * a phone; email is preferred when both exist. The sentinel
 * `@phone.vertov.local` emails are stored NULL, so a non-null email here is
 * always a real, deliverable address.
 */
async function customerContactFor(
  userId: string,
): Promise<{ email: string | null; phone: string | null }> {
  const rows = await db
    .select({ email: usersPii.email, phone: usersPii.phone })
    .from(usersPii)
    .where(eq(usersPii.id, userId))
    .limit(1);
  return { email: rows[0]?.email ?? null, phone: rows[0]?.phone ?? null };
}

const checkoutSchema = z.object({
  packId: z.string().min(1),
  customerEmail: z.string().email().optional(),
});
const refundSchema = z.object({
  orderId: z.string().min(1),
  amountRub: z.number().positive().optional(),
  // Tochka's refundUid is the provider-side idempotency key. A caller must
  // supply a distinct value for each legitimate partial refund; retries reuse
  // the same value and cannot create a second PSP operation.
  refundUid: z
    .string()
    .regex(/^[0-9A-Za-z-]{1,64}$/)
    .optional(),
});

// Top-up packs are an add-on for existing paid plans, not a second way to buy
// model access. Keep this API boundary aligned with `arePacksUnlocked` in the
// pricing UI, and give payment-link creation its own conservative abuse bucket.
// The global limiter remains a backstop; this route-local bucket is independent.
export const CHECKOUT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

interface SessionLike {
  user: { id: string };
}

type SessionResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike | null>;

class UnknownPaymentError extends Error {
  constructor(public readonly paymentId: string) {
    super(`unknown payment ${paymentId}`);
    this.name = 'UnknownPaymentError';
  }
}

/** `metadata.orderId` as we sent it to the PSP, when the event object is a payment. */
function orderRefFromEvent(object: Record<string, unknown> | undefined): string | null {
  const meta = (object as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const ref = meta?.orderId;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

/**
 * Keep an event we could not attribute to an order. Paired with a non-2xx
 * response so the PSP keeps retrying; the row is the durable record if its
 * retries run out, and `attempts` says how hard it tried.
 */
async function retainUnresolvedEvent(entry: {
  event: string;
  objectId: string;
  pspPaymentId: string | null;
  orderRef: string | null;
  payload: Record<string, unknown>;
}): Promise<number> {
  const [row] = await db
    .insert(billingUnresolvedEvents)
    .values({
      id: nid(),
      event: entry.event,
      objectId: entry.objectId,
      pspPaymentId: entry.pspPaymentId,
      orderRef: entry.orderRef,
      payload: truncatePayload(entry.payload),
    })
    .onConflictDoUpdate({
      target: [billingUnresolvedEvents.event, billingUnresolvedEvents.objectId],
      set: {
        attempts: sql`${billingUnresolvedEvents.attempts} + 1`,
        lastSeenAt: new Date(),
        payload: truncatePayload(entry.payload),
      },
    })
    .returning({ attempts: billingUnresolvedEvents.attempts });
  const attempts = row?.attempts ?? 1;
  billingUnresolvedEventsTotal.labels(entry.event).inc();
  return attempts;
}

/** Keep the row small — a webhook body is attacker-influenced and unbounded. */
function truncatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(payload);
  if (json.length <= MAX_RETAINED_PAYLOAD_CHARS) return payload;
  return { truncated: true, bytes: json.length, head: json.slice(0, MAX_RETAINED_PAYLOAD_CHARS) };
}

/**
 * How the route answers an event it could not settle.
 *
 * Non-2xx makes ЮKassa retry, which is what rescues the narrow race where the
 * order row or its payment binding is a moment behind the event. But retrying
 * forever is not a strategy: past this many attempts the event is not a race,
 * it is a reconciliation item, and it is already stored durably. Acknowledge so
 * the provider stops hammering, and let the row + its metric be the signal.
 */
const MAX_UNRESOLVED_RETRY_ATTEMPTS = 6;
const MAX_RETAINED_PAYLOAD_CHARS = 4_000;

/** Non-2xx while a retry can still plausibly resolve it; 200 once it is parked. */
function unresolvedReply(reply: FastifyReply, attempts: number, reason: string) {
  if (attempts <= MAX_UNRESOLVED_RETRY_ATTEMPTS) {
    return reply.status(500).send({ error: 'unresolved_payment', reason });
  }
  return reply.status(200).send({ ok: true, retained: 'unresolved_payment', attempts, reason });
}

/** The event finally landed — what is left in the table is what is still stranded. */
async function dropUnresolvedEvent(event: string, objectId: string): Promise<void> {
  await db
    .delete(billingUnresolvedEvents)
    .where(
      and(eq(billingUnresolvedEvents.event, event), eq(billingUnresolvedEvents.objectId, objectId)),
    );
}

// The 5-tier grid + legacy `creator` (existing subs) + `free`. Kept as a local
// literal union rather than importing the drizzle enum so the webhook apply path
// has no schema-package type coupling.
type TierName = 'free' | 'start' | 'creator' | 'studio' | 'plus' | 'pro' | 'max';

type OrderMetadata = {
  purpose?: 'subscribe' | 'upgrade' | 'renewal';
  subscriptionId?: string;
  cycleNumber?: number;
  fromTier?: TierName;
  toTier?: TierName;
  proratedDays?: number;
  paymentLinkId?: string;
  providerSubscriptionId?: string;
  consumerId?: string;
  confirmationUrl?: string;
} | null;

function tochkaOperation(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = (payload.Data ?? payload.data ?? payload) as Record<string, unknown>;
  return Array.isArray(nested.Operation)
    ? ((nested.Operation[0] as Record<string, unknown> | undefined) ?? {})
    : nested;
}

function tochkaStatus(payload: Record<string, unknown>): string | undefined {
  const operation = tochkaOperation(payload);
  const operationStatus = operation.status ?? operation.Status;
  const payloadStatus = payload.status ?? payload.Status;
  const nestedStatus =
    operationStatus && typeof operationStatus === 'object'
      ? ((operationStatus as Record<string, unknown>).value ??
        (operationStatus as Record<string, unknown>).Value)
      : undefined;
  return (
    (typeof operationStatus === 'string' && operationStatus) ||
    (typeof nestedStatus === 'string' && nestedStatus) ||
    (typeof payloadStatus === 'string' && payloadStatus) ||
    undefined
  );
}

function tochkaSuccessfulStatus(status: string | undefined): boolean {
  return ['APPROVED', 'COMPLETED', 'SUCCEEDED', 'PAID'].includes(status?.toUpperCase() ?? '');
}

/**
 * Tochka provider statuses whose payment page can still be paid. Compared
 * case-insensitively — the provider has been observed in both cases.
 */
export const RESUMABLE_TOCHKA_STATUSES = ['CREATED', 'PENDING', 'PROCESSING', 'WAITING'];

/**
 * Payment-resume recovery for a bounced Tochka form: the payment stays live
 * (CREATED, zero attempts) while our order sits `pending`, and a retry from
 * the site is refused with 409 `checkout_in_progress` — so the return page
 * must hand the buyer the SAME confirmation link instead of dead-ending.
 *
 * Returns a URL only when the order is still `pending`, carries a provider
 * payment id, and the (live, else stored) provider status is still payable.
 * The URL is the persisted `metadata.confirmationUrl`, falling back for
 * `tochka` orders to the documented provider-contract payment-page pattern.
 * Anything else — paid, failed, refunded, dead or unknown status, missing
 * payment id — returns null (fail closed). Never releases the intent slot;
 * that stays W1-0's job.
 */
export function resumeUrlForOrder(
  order: {
    ourStatus: string;
    pspPaymentId: string | null;
    psp: string;
    pspStatus?: string | null;
    metadata: unknown;
  },
  providerStatus?: string | null,
): string | null {
  if (order.ourStatus !== 'pending') return null;
  if (!order.pspPaymentId) return null;
  const rawStatus = providerStatus ?? order.pspStatus ?? null;
  if (!rawStatus || !RESUMABLE_TOCHKA_STATUSES.includes(rawStatus.toUpperCase())) return null;
  const meta =
    order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
      ? (order.metadata as Record<string, unknown>)
      : null;
  const stored = meta?.confirmationUrl;
  if (typeof stored === 'string' && stored.length > 0) return stored;
  if (order.psp === 'tochka') {
    // Provider-contract fallback: Tochka's hosted payment page for the
    // operation. Used only when the persisted confirmation URL is missing.
    return `https://merch.securepaytb.ru/order/?uuid=${order.pspPaymentId}`;
  }
  return null;
}

function tochkaAmountRub(payload: Record<string, unknown>): number | null {
  const operation = tochkaOperation(payload);
  const raw =
    operation.amount ??
    operation.Amount ??
    operation.amountRub ??
    operation.AmountRub ??
    payload.amount ??
    payload.Amount;
  const value =
    raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).amount ??
        (raw as Record<string, unknown>).Amount ??
        (raw as Record<string, unknown>).value ??
        (raw as Record<string, unknown>).Value)
      : raw;
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function tochkaRefundUid(
  payload: Record<string, unknown>,
  operation: Record<string, unknown>,
): string | null {
  return (
    (typeof operation.refundUid === 'string' && operation.refundUid) ||
    (typeof operation.RefundUid === 'string' && operation.RefundUid) ||
    (typeof operation.refundId === 'string' && operation.refundId) ||
    (typeof operation.RefundId === 'string' && operation.RefundId) ||
    (typeof operation.refundOperationId === 'string' && operation.refundOperationId) ||
    (typeof operation.RefundOperationId === 'string' && operation.RefundOperationId) ||
    (typeof payload.refundUid === 'string' && payload.refundUid) ||
    (typeof payload.RefundUid === 'string' && payload.RefundUid) ||
    (typeof payload.refundId === 'string' && payload.refundId) ||
    (typeof payload.RefundId === 'string' && payload.RefundId) ||
    (typeof payload.refundOperationId === 'string' && payload.refundOperationId) ||
    (typeof payload.RefundOperationId === 'string' && payload.RefundOperationId) ||
    null
  );
}

function tochkaRefundKey(
  payload: Record<string, unknown>,
  operation: Record<string, unknown>,
  paymentId: string,
  status: string | undefined,
): string {
  const refundUid = tochkaRefundUid(payload, operation);
  // New Tochka refund notifications carry refundUid. For older notifications
  // that do not, use only stable operation facts; hashing the whole body would
  // make a retry with a volatile timestamp look like a second refund.
  const operationId =
    (typeof operation.operationId === 'string' && operation.operationId) ||
    (typeof operation.id === 'string' && operation.id) ||
    (typeof payload.operationId === 'string' && payload.operationId) ||
    paymentId;
  const amount = tochkaAmountRub(payload);
  const discriminator =
    refundUid ??
    createHash('sha256')
      .update(JSON.stringify({ paymentId, status, operationId, amount }))
      .digest('hex')
      .slice(0, 32);
  return `clawback:tochka:${paymentId}:${discriminator}`;
}

/**
 * Stable unresolved-event identity for a signed refund that carries only our
 * paymentLinkId. The link identifies the local order, not the PSP operation;
 * keeping this fact separate lets the reconciliation operation-list lookup
 * discover and bind the real payment id later.
 */
export function tochkaUnboundRefundEventKey(orderRef: string, status: string): string {
  return `unbound-refund:tochka:${orderRef}:${status}`;
}

type TochkaRefundEntry = {
  id: string;
  refundUid?: string;
  providerRefundId?: string;
  amountRub?: number;
};

function amountFromValue(value: unknown): number | undefined {
  const raw =
    value && typeof value === 'object'
      ? ((value as Record<string, unknown>).amount ??
        (value as Record<string, unknown>).Amount ??
        (value as Record<string, unknown>).value ??
        (value as Record<string, unknown>).Value)
      : value;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Expand a Tochka refund notification into one durable operation per refund.
 * A payment's `Order[]` can contain several equal partial refunds; using the
 * payment id or the top-level refundUid for all of them would silently merge
 * those operations and under-claw the account.
 */
function tochkaRefundEntries(
  payload: Record<string, unknown>,
  operation: Record<string, unknown>,
  status: string,
  paymentId: string,
): TochkaRefundEntry[] {
  const rows = operation.Order ?? operation.order;
  if (Array.isArray(rows)) {
    const entries: TochkaRefundEntry[] = [];
    const seen = new Set<string>();
    let missingAmount = false;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const entry = row as Record<string, unknown>;
      if (String(entry.type ?? entry.Type ?? '').toLowerCase() !== 'refund') continue;
      const refundUid =
        (typeof entry.refundUid === 'string' && entry.refundUid) ||
        (typeof entry.RefundUid === 'string' && entry.RefundUid) ||
        (typeof entry.refundId === 'string' && entry.refundId) ||
        (typeof entry.RefundId === 'string' && entry.RefundId) ||
        undefined;
      const providerRefundId =
        (typeof entry.providerRefundId === 'string' && entry.providerRefundId) ||
        (typeof entry.ProviderRefundId === 'string' && entry.ProviderRefundId) ||
        (typeof entry.refundOperationId === 'string' && entry.refundOperationId) ||
        (typeof entry.RefundOperationId === 'string' && entry.RefundOperationId) ||
        (typeof entry.orderId === 'string' && entry.orderId) ||
        (typeof entry.OrderId === 'string' && entry.OrderId) ||
        undefined;
      const fallbackId =
        providerRefundId || (typeof entry.id === 'string' && entry.id) || refundUid;
      // Prefer the provider refund UID when present. Some snapshots repeat the
      // parent payment operation id for every partial row; using that value as
      // the identity would merge equal partial refunds and under-claw the user.
      const id = refundUid ?? fallbackId;
      if (!id || seen.has(id)) {
        // Multiple rows without distinct stable ids cannot be applied safely.
        // Returning no entries retains the authenticated webhook for the
        // reconciliation path instead of silently dropping one refund.
        if (id && seen.has(id)) return [];
        continue;
      }
      seen.add(id);
      const amountRub = amountFromValue(
        entry.amount ?? entry.Amount ?? entry.refundAmount ?? entry.refundedAmount,
      );
      if (status === 'REFUNDED_PARTIALLY' && amountRub == null) return [];
      if (amountRub == null) missingAmount = true;
      entries.push({
        id,
        ...(refundUid ? { refundUid } : {}),
        ...(providerRefundId && providerRefundId !== id ? { providerRefundId } : {}),
        ...(amountRub ? { amountRub } : {}),
      });
    }
    if (entries.length > 1 && missingAmount) return [];
    if (entries.length > 0) return entries;
  }

  const refundUid = tochkaRefundUid(payload, operation) ?? undefined;
  const providerRefundId =
    (typeof operation.providerRefundId === 'string' && operation.providerRefundId) ||
    (typeof operation.ProviderRefundId === 'string' && operation.ProviderRefundId) ||
    (typeof operation.refundOperationId === 'string' && operation.refundOperationId) ||
    (typeof operation.RefundOperationId === 'string' && operation.RefundOperationId) ||
    (typeof payload.providerRefundId === 'string' && payload.providerRefundId) ||
    (typeof payload.ProviderRefundId === 'string' && payload.ProviderRefundId) ||
    undefined;
  const amountRub =
    status === 'REFUNDED_PARTIALLY'
      ? amountFromValue(
          operation.refundAmount ?? operation.refundedAmount ?? operation.refund_amount,
        )
      : (tochkaAmountRub(payload) ?? undefined);
  // A partial refund without both a stable id and an amount is not safe to
  // apply. The caller retains the notification for reconciliation instead.
  if (status === 'REFUNDED_PARTIALLY' && (!refundUid || amountRub == null)) return [];
  return [
    {
      id: refundUid ?? paymentId,
      ...(refundUid ? { refundUid } : {}),
      ...(providerRefundId ? { providerRefundId } : {}),
      ...(amountRub ? { amountRub } : {}),
    },
  ];
}

const CYCLE_DAYS = 30;
const CYCLE_MS = CYCLE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Locate the local order an event is about. The primary key is `psp_payment_id`;
 * the fallback is the order id we put in the payment's metadata
 * (`yookassa/src/index.ts` `metadata.orderId`), which covers the window between
 * the intent-first insert and the attach of the provider's payment id.
 */
async function resolveOrderRef(
  paymentId: string,
  orderRef?: string | null,
): Promise<{ id: string; userId: string; psp: string; via: 'payment' | 'metadata' } | null> {
  const [byPayment] = await db
    .select({ id: orders.id, userId: orders.userId, psp: orders.psp })
    .from(orders)
    .where(eq(orders.pspPaymentId, paymentId))
    .limit(1);
  if (byPayment) return { ...byPayment, via: 'payment' };
  if (!orderRef) return null;
  const [byOrder] = await db
    .select({
      id: orders.id,
      userId: orders.userId,
      psp: orders.psp,
      pspPaymentId: orders.pspPaymentId,
    })
    .from(orders)
    .where(eq(orders.id, orderRef))
    .limit(1);
  if (!byOrder) return null;
  // The order is already bound to a DIFFERENT payment. Never settle one payment
  // against another payment's order — leave the event unresolved so it is
  // retained for reconciliation rather than applied to the wrong purchase.
  // NOTE: this read is outside the transaction and is only a fast reject; the
  // binding is re-checked under FOR UPDATE below, which is the check that counts.
  if (byOrder.pspPaymentId && byOrder.pspPaymentId !== paymentId) return null;
  return { id: byOrder.id, userId: byOrder.userId, psp: byOrder.psp, via: 'metadata' };
}

/**
 * A settlement we refuse to perform, but which is NOT the customer's problem to
 * absorb: the order stays `pending` and the event is retained, so the money is
 * recorded and recoverable rather than silently accepted or silently dropped.
 *
 * Deliberately NOT a disposition. Deciding what a stranded payment is owed —
 * deliver, refund, or supersede — is W1-1 (`refund_due`), and doing it here
 * without a refund path would take the money and deliver nothing.
 */
class UnsettleableOrderError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly reason: string,
  ) {
    super(`order ${orderId} not settleable: ${reason}`);
    this.name = 'UnsettleableOrderError';
  }
}

/** Payment facts read back from the provider, for the metadata-fallback path. */
type PaymentRetriever = (
  providerPaymentId: string,
) => Promise<{ status: string; amountRub: number | null } | null>;

/** Select the metadata-fallback verifier for the provider that owns the order. */
function paymentRetrieverFor(psp: string): PaymentRetriever {
  if (psp === 'tochka') {
    return async (paymentId: string) => {
      const payload = await getTochkaAdapter().getPaymentInfo(paymentId);
      const status = tochkaStatus(payload);
      return {
        status: tochkaSuccessfulStatus(status) ? 'succeeded' : (status ?? 'unknown'),
        amountRub: tochkaAmountRub(payload),
      };
    };
  }
  return (paymentId: string) => getAdapter().retrievePayment(paymentId);
}

/**
 * Verify a payment we could only attribute through OUR OWN metadata.
 *
 * The webhook body is authenticated by a shared bearer, which proves the sender
 * knows the secret — not that money moved. Without this check a leaked secret
 * escalates from "replay a payment that really happened" to "mint a
 * `payment.succeeded` naming any pending order and have it granted". So before
 * binding an unbound order we ask the provider what it actually holds.
 *
 * Fails CLOSED: an unknown payment, a non-succeeded status, a mismatched amount
 * or a failed lookup all mean "do not grant". Stranding is recoverable; a wrong
 * grant is not.
 */
async function verifyMetadataResolvedPayment(
  retrieve: PaymentRetriever,
  paymentId: string,
  order: { id: string; amountRub: number },
): Promise<void> {
  let retrieved: Awaited<ReturnType<PaymentRetriever>>;
  try {
    retrieved = await retrieve(paymentId);
  } catch (err) {
    throw new UnsettleableOrderError(order.id, `psp lookup failed: ${(err as Error).message}`);
  }
  if (!retrieved) throw new UnsettleableOrderError(order.id, 'psp does not know this payment');
  if (retrieved.status !== 'succeeded') {
    throw new UnsettleableOrderError(order.id, `psp status is ${retrieved.status}, not succeeded`);
  }
  // A null amount means the adapter cannot assert one (stub only, refused in
  // production) — an absent check, never a pass.
  if (retrieved.amountRub != null && retrieved.amountRub !== order.amountRub) {
    throw new UnsettleableOrderError(
      order.id,
      `psp amount ${retrieved.amountRub} != order amount ${order.amountRub}`,
    );
  }
}

/**
 * Apply a successful payment to the ledger, dispatching on `orders.kind`
 * and `orders.metadata.purpose`. Idempotent via the grant's
 * `idempotencyKey` (one key per logical credit event: pack purchase,
 * subscription subscribe, upgrade-prorated grant, or cycle renewal).
 *
 * Order flip + ledger grant land inside ONE db.transaction so a process
 * crash never leaves the user credited but the order still pending.
 */
async function applyPaymentSucceeded(
  paymentId: string,
  /**
   * `metadata.orderId` from the PSP event. W1-0: the local order row now exists
   * before the payment does, so an event that outruns the `psp_payment_id`
   * write is still ours — resolving by it is what stops the money being
   * stranded behind a `200 unknown_payment`.
   */
  orderRef?: string | null,
  deps: { retrievePayment?: PaymentRetriever } = {},
): Promise<{
  granted: boolean;
  orderId: string;
  credits: number;
  kind: 'pack' | 'subscription';
}> {
  const owner = await resolveOrderRef(paymentId, orderRef);
  if (!owner) throw new UnknownPaymentError(paymentId);

  if (owner.via === 'metadata') {
    // Ask the provider what it actually holds BEFORE we touch the ledger, and
    // outside the transaction — never an HTTP call inside a money tx.
    const [snapshot] = await db
      .select({ id: orders.id, amountRub: orders.amountRub })
      .from(orders)
      .where(eq(orders.id, owner.id))
      .limit(1);
    if (!snapshot) throw new UnknownPaymentError(paymentId);
    const retrieve = deps.retrievePayment ?? paymentRetrieverFor(owner.psp);
    await verifyMetadataResolvedPayment(retrieve, paymentId, snapshot);
  }

  return db.transaction(async (tx) => {
    await lockMediaStorageUser(tx, owner.userId);
    const orderRows = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, owner.id))
      .limit(1)
      .for('update');
    const order = orderRows[0];
    if (!order) throw new UnknownPaymentError(paymentId);
    // TOCTOU: `resolveOrderRef` read the binding outside this lock, so a real
    // payment may have bound itself in between. Re-check under FOR UPDATE —
    // this is the check that actually prevents settling one payment against
    // another payment's order.
    if (order.pspPaymentId != null && order.pspPaymentId !== paymentId) {
      throw new UnsettleableOrderError(order.id, 'order is bound to a different payment');
    }
    if (!order.pspPaymentId) {
      // Resolved by metadata and verified against the provider: bind the
      // payment inside the same transaction that grants, so a retry
      // short-circuits on `pspPaymentId`.
      await tx.update(orders).set({ pspPaymentId: paymentId }).where(eq(orders.id, order.id));
    }

    // Short-circuit unless the order is still pending. The pack + upgrade paths
    // dedupe via stable ledger keys (`yk:${paymentId}`, `sub:${id}:upgrade:order:${orderId}`),
    // but the SUBSCRIBE path mints a fresh subscriptions row + cycle-1 key on
    // every call — so a YooKassa webhook retry (or a replay) would create a
    // brand-new subscription and grant credits every time. This guard makes every
    // branch idempotent against re-invocation regardless of the per-branch dedup.
    // M2: gate on the FULL terminal set, not just 'paid'. A refund/cancel sets
    // ourStatus to 'refunded'/'failed' (reversePaymentGrant); a payment.succeeded
    // delivered or replayed AFTER that previously slipped past a `=== 'paid'`
    // check and re-granted the whole subscription. Only a still-pending order may
    // be granted (enum: pending|paid|refunded|failed).
    if (order.ourStatus !== 'pending') {
      return { granted: false, orderId: order.id, credits: 0, kind: order.kind };
    }

    if (order.kind === 'pack') {
      const packRows = await tx
        .select()
        .from(creditPacks)
        .where(eq(creditPacks.id, order.tierOrPackId))
        .limit(1);
      const pack = packRows[0];
      if (!pack) throw new Error(`pack ${order.tierOrPackId} missing for order ${order.id}`);
      await credits.grant({
        userId: order.userId,
        amount: pack.credits,
        account: 'pack_grant',
        origin: 'pack',
        expiresAt: null,
        reason: 'pack.purchase',
        sourceOrderId: order.id,
        idempotencyKey: `yk:${paymentId}`,
        tx,
      });
      creditsGrantTotal.labels('pack_grant').inc(pack.credits);
      await grantWelcomeL3(order.userId, tx, order.id, order.amountRub);
      await tx
        .update(orders)
        .set({ ourStatus: 'paid', pspStatus: 'succeeded', paidAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.ourStatus, 'pending')));
      // A top-up is a paid-media entitlement, but never a subscription-plan
      // entitlement. Promote existing assets in the same settlement tx; future
      // writes consult hasPaidMediaStorage and see this now-paid order.
      await tx
        .update(galleryItems)
        .set({ expiresAt: null })
        .where(and(eq(galleryItems.userId, order.userId), isNull(galleryItems.deletedAt)));
      return { granted: true, orderId: order.id, credits: pack.credits, kind: 'pack' as const };
    }

    // kind === 'subscription' — dispatch on metadata.purpose.
    const meta = (order.metadata as OrderMetadata) ?? {};
    const tier = order.tierOrPackId as TierName;

    if (meta.purpose === 'subscribe' || !meta.purpose) {
      const catalogRows = await tx
        .select()
        .from(subscriptionsCatalog)
        .where(eq(subscriptionsCatalog.tier, tier))
        .limit(1);
      const cat = catalogRows[0];
      if (!cat) throw new Error(`subscription tier ${tier} missing in catalog`);
      const now = new Date();
      const subId = nid();
      const settledMetadata = { ...meta, purpose: 'subscribe' as const, subscriptionId: subId };
      const periodEnd = new Date(now.getTime() + CYCLE_MS);
      await tx.insert(subscriptions).values({
        id: subId,
        userId: order.userId,
        tier,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true, // anti-pattern wedge: opt-in renewal.
        cycleNumber: 1,
        priceRub: cat.priceRub,
        creditsPerCycle: cat.creditsPerCycle,
        ...(meta.providerSubscriptionId ? { pspSubscriptionId: meta.providerSubscriptionId } : {}),
        ...(meta.consumerId ? { pspConsumerId: meta.consumerId } : {}),
      });
      if (await hasPaidMediaStorage(tx, order.userId, now)) {
        await tx
          .update(galleryItems)
          .set({ expiresAt: null })
          .where(and(eq(galleryItems.userId, order.userId), isNull(galleryItems.deletedAt)));
      }
      await credits.grant({
        userId: order.userId,
        amount: cat.creditsPerCycle,
        account: 'subscription_grant',
        origin: 'subscription',
        expiresAt: periodEnd,
        reason: 'subscription.subscribe',
        sourceOrderId: order.id,
        sourceSubscriptionId: subId,
        cycleNumber: 1,
        idempotencyKey: `sub:${subId}:cycle:1`,
        tx,
      });
      creditsGrantTotal.labels('subscription_grant').inc(cat.creditsPerCycle);
      await grantWelcomeL3(order.userId, tx, order.id, order.amountRub);
      await tx
        .update(orders)
        .set({
          ourStatus: 'paid',
          pspStatus: 'succeeded',
          paidAt: new Date(),
          // Bind the delivered subscription to its source order. Refunds and
          // support reconciliation must be able to revoke the exact plan
          // created by this payment, including after a catalog/provider edit.
          metadata: settledMetadata,
        })
        .where(and(eq(orders.id, order.id), eq(orders.ourStatus, 'pending')));
      return {
        granted: true,
        orderId: order.id,
        credits: cat.creditsPerCycle,
        kind: 'subscription' as const,
      };
    }

    if (meta.purpose === 'upgrade') {
      const subId = meta.subscriptionId;
      if (!subId) throw new Error(`upgrade order ${order.id} missing subscriptionId in metadata`);
      const subRows = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subId))
        .limit(1);
      const sub = subRows[0];
      if (!sub) throw new Error(`upgrade order ${order.id} references missing sub ${subId}`);
      const newCatRows = await tx
        .select()
        .from(subscriptionsCatalog)
        .where(eq(subscriptionsCatalog.tier, tier))
        .limit(1);
      const newCat = newCatRows[0];
      if (!newCat) throw new Error(`upgrade target tier ${tier} missing in catalog`);
      // An upgrade is priced against a live period. If the customer cancelled
      // or the period elapsed before the PSP webhook arrived, do not accept a
      // payment that would only rewrite a label (the old 1 ₽ lapsed-upgrade
      // trap). Keep the order pending for reconciliation/refund instead.
      if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
        throw new UnsettleableOrderError(
          order.id,
          `subscription ${sub.id} is ${sub.status}, not settleable for upgrade`,
        );
      }
      if (sub.currentPeriodEnd <= new Date()) {
        throw new UnsettleableOrderError(
          order.id,
          `subscription ${sub.id} period ended before upgrade settled`,
        );
      }
      // The baseline this order was priced against must still be the tier the
      // subscription is on. If another upgrade landed first, this payment buys
      // a tier at or below the current one: granting it would credit nothing
      // (the delta is negative) and REWRITE THE SUBSCRIPTION DOWNWARD — the
      // customer pays to be demoted. Refuse to act, leave the order pending,
      // and let the event be retained. Whether this payment is then delivered,
      // refunded or superseded is R9/W1-1, not a decision this phase may make.
      if (newCat.priceRub <= sub.priceRub) {
        throw new UnsettleableOrderError(
          order.id,
          `stale upgrade baseline: order targets ${tier} (${newCat.priceRub}₽) but the subscription is already on ${sub.tier} (${sub.priceRub}₽)`,
        );
      }
      const daysRemaining = meta.proratedDays ?? 0;
      const proratedCredits = Math.round(
        ((newCat.creditsPerCycle - sub.creditsPerCycle) * daysRemaining) / CYCLE_DAYS,
      );
      if (proratedCredits > 0) {
        await credits.grant({
          userId: order.userId,
          amount: proratedCredits,
          account: 'subscription_grant',
          origin: 'subscription',
          expiresAt: sub.currentPeriodEnd,
          reason: 'subscription.upgrade.prorated',
          sourceOrderId: order.id,
          sourceSubscriptionId: subId,
          cycleNumber: sub.cycleNumber,
          // Keyed by the ORDER, not the cycle. `cycleNumber` only advances at
          // renewal, so two legitimate upgrades inside one paid month (Старт →
          // Плюс, then Плюс → Про) shared a key and the second grant was
          // silently deduped away — charged, tier moved, no credits. The order
          // id is unique per upgrade and stable across webhook retries, so a
          // REPLAYED webhook for the same order still dedupes.
          idempotencyKey: `sub:${subId}:upgrade:order:${order.id}`,
          tx,
        });
        creditsGrantTotal.labels('subscription_grant').inc(proratedCredits);
      }
      await tx
        .update(subscriptions)
        .set({
          tier,
          priceRub: newCat.priceRub,
          creditsPerCycle: newCat.creditsPerCycle,
          // An upgrade supersedes any scheduled downgrade.
          pendingTier: null,
        })
        .where(eq(subscriptions.id, subId));
      if (await hasPaidMediaStorage(tx, order.userId, new Date())) {
        await tx
          .update(galleryItems)
          .set({ expiresAt: null })
          .where(and(eq(galleryItems.userId, order.userId), isNull(galleryItems.deletedAt)));
      }
      await tx
        .update(orders)
        .set({ ourStatus: 'paid', pspStatus: 'succeeded', paidAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.ourStatus, 'pending')));
      return {
        granted: true,
        orderId: order.id,
        credits: proratedCredits,
        kind: 'subscription' as const,
      };
    }

    if (meta.purpose === 'renewal') {
      // Legacy/YooKassa renewals are already settled by the worker. Tochka
      // renewals remain pending until this signed webhook, which then grants
      // the cycle and advances the local period exactly once.
      const renewalSubId = meta.subscriptionId;
      const renewalCycle = meta.cycleNumber;
      if (renewalSubId && renewalCycle) {
        const [sub] = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.id, renewalSubId))
          .limit(1)
          .for('update');
        if (!sub)
          throw new Error(`renewal order ${order.id} references missing sub ${renewalSubId}`);
        if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
          throw new UnsettleableOrderError(
            order.id,
            `renewal ${order.id} references ${sub.status} subscription ${sub.id}`,
          );
        }
        if (sub.cycleNumber < renewalCycle) {
          await credits.grant({
            userId: order.userId,
            amount: sub.creditsPerCycle,
            account: 'subscription_grant',
            reason: 'subscription.cycle.renewal',
            sourceOrderId: order.id,
            idempotencyKey: `sub:${sub.id}:cycle:${renewalCycle}`,
            tx,
          });
          creditsGrantTotal.labels('subscription_grant').inc(sub.creditsPerCycle);
          const periodStart = sub.currentPeriodEnd;
          await tx
            .update(subscriptions)
            .set({
              cycleNumber: renewalCycle,
              currentPeriodStart: periodStart,
              currentPeriodEnd: new Date(periodStart.getTime() + CYCLE_MS),
              status: 'active',
            })
            .where(eq(subscriptions.id, sub.id));
        }
      }
      await tx
        .update(orders)
        .set({ ourStatus: 'paid', pspStatus: 'succeeded', paidAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.ourStatus, 'pending')));
      return { granted: true, orderId: order.id, credits: 0, kind: 'subscription' as const };
    }

    throw new Error(`unknown subscription order purpose: ${meta.purpose}`);
  });
}

/**
 * BL-14: reverse the credit grant when a paid order is refunded or canceled.
 *
 * Writes an idempotent clawback (negative `available` leg) for the credits that
 * were granted FOR THIS ORDER, capped so cumulative reversal never exceeds the
 * grant (robust to partial refunds, retries, and a cancel-after-refund). The
 * order status flip + clawback land in ONE transaction. Balance is allowed to
 * go negative if the user already spent the refunded credits.
 */
export type TochkaRefundReversal = {
  /** The PSP PAYMENT id (orders.pspPaymentId) — used to locate the order. */
  paymentId: string;
  /** `metadata.orderId` from the event, when the event object is a payment. */
  orderRef?: string | null;
  /** Idempotency key for the clawback leg. */
  reversalKey: string;
  newStatus: 'failed' | 'refunded';
  /** Refunded amount in RUB for a partial refund; omit for a full reversal. */
  refundedRub?: number;
  /** Stable provider refund operation id. Defaults to the reversal key for
   * legacy callers that do not receive a provider id. */
  providerRefundId?: string | null;
  /** Our provider idempotency key. Defaults to reversalKey. */
  refundUid?: string | null;
  /** Provider status at the point this reversal was observed. */
  providerStatus?: string | null;
};

type RefundRow = typeof billingRefunds.$inferSelect;

function rubCents(value: number): number {
  return Math.round(value * 100);
}

function refundAmountRub(orderAmountRub: number, refundedRub: number | undefined): number {
  let cents = rubCents(orderAmountRub);
  if (refundedRub != null) {
    if (!Number.isFinite(refundedRub) || refundedRub <= 0) {
      throw new Error('refund amount must be positive');
    }
    cents = Math.max(1, rubCents(refundedRub));
  }
  if (cents <= 0) throw new Error('refund amount must be positive');
  if (cents > rubCents(orderAmountRub)) throw new Error('refund amount exceeds payment');
  return cents / 100;
}

/**
 * Upsert one confirmed refund operation under the same transaction/lock as
 * the clawback. Provider retries find the existing row by UID or provider id;
 * two legitimate partial refunds remain two rows even when their amounts are
 * equal.
 */
async function ensureConfirmedRefund(
  tx: BillingTx,
  input: {
    order: { id: string; psp: string; pspPaymentId: string; amountRub: number };
    reversalKey: string;
    refundUid?: string | null;
    providerRefundId?: string | null;
    amountRub: number;
    providerStatus?: string | null;
  },
): Promise<RefundRow> {
  // Calls that carry a provider-issued UID must use that UID globally for the
  // PSP so a replay cannot be attached to a different order. Legacy/internal
  // callers may only have a local reversal key; scope that synthetic key to
  // the order so fixed test keys (and old retries) cannot collide across
  // otherwise unrelated payments.
  const suppliedRefundUid = input.refundUid?.trim() || null;
  let refundUid = suppliedRefundUid ?? `${input.order.id}:${input.reversalKey}`;
  const rawProviderRefundId = input.providerRefundId?.trim() || null;
  // A provider-issued refund UID is the only identity that can distinguish two
  // legitimate partial refunds. Tochka snapshots have been observed to repeat
  // the parent payment/order id in `providerRefundId` for every partial row. Do
  // not use that repeated value as an alternate lookup (or a unique ledger
  // column) when a distinct UID is present — doing so would find the first
  // equal partial and silently skip the second. Preserve the provider id only
  // when it is itself the UID or when no stronger UID exists.
  const providerRefundId =
    !suppliedRefundUid || rawProviderRefundId === suppliedRefundUid ? rawProviderRefundId : null;
  const predicatesFor = (uid: string) => {
    const predicates = [
      and(eq(billingRefunds.psp, input.order.psp), eq(billingRefunds.refundUid, uid)),
    ];
    if (providerRefundId && !suppliedRefundUid) {
      predicates.push(
        and(
          eq(billingRefunds.psp, input.order.psp),
          eq(billingRefunds.providerRefundId, providerRefundId),
        ),
      );
    }
    return predicates;
  };
  let predicates = predicatesFor(refundUid);
  let [row] = await tx
    .select()
    .from(billingRefunds)
    .where(or(...predicates))
    .limit(1)
    .for('update');
  // If an old synthetic key was already used for another order, retry with
  // the order-scoped form. A real provider UID still fails closed below.
  if (
    row &&
    !suppliedRefundUid &&
    !providerRefundId &&
    (row.orderId !== input.order.id || row.pspPaymentId !== input.order.pspPaymentId)
  ) {
    refundUid = `${input.order.id}:${input.reversalKey}`;
    predicates = predicatesFor(refundUid);
    [row] = await tx
      .select()
      .from(billingRefunds)
      .where(or(...predicates))
      .limit(1)
      .for('update');
  }
  if (!row) {
    const inserted = await tx
      .insert(billingRefunds)
      .values({
        id: nid(),
        psp: input.order.psp,
        orderId: input.order.id,
        pspPaymentId: input.order.pspPaymentId,
        refundUid,
        providerRefundId,
        amountRub: input.amountRub.toFixed(2),
        status: 'confirmed',
        providerStatus: input.providerStatus ?? null,
        confirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    row = inserted[0];
    if (!row) {
      [row] = await tx
        .select()
        .from(billingRefunds)
        .where(or(...predicates))
        .limit(1)
        .for('update');
    }
  }
  if (!row) throw new Error('refund ledger row disappeared after insert');
  if (row.orderId !== input.order.id || row.pspPaymentId !== input.order.pspPaymentId) {
    throw new Error('refund operation is bound to a different order/payment');
  }
  // A provider UID is immutable: seeing the same operation with a different
  // amount is an attribution/data-integrity conflict, never a reason to
  // rewrite the ledger and claw back a new amount on replay.
  if (rubCents(Number(row.amountRub)) !== rubCents(input.amountRub)) {
    throw new Error('refund operation amount mismatch');
  }
  if (providerRefundId && row.providerRefundId && row.providerRefundId !== providerRefundId) {
    throw new Error('refund provider id conflict');
  }
  if (row.status === 'rejected') {
    const [updated] = await tx
      .update(billingRefunds)
      .set({
        status: 'confirmed',
        amountRub: input.amountRub.toFixed(2),
        providerRefundId: row.providerRefundId ?? providerRefundId,
        providerStatus: input.providerStatus ?? row.providerStatus,
        confirmedAt: row.confirmedAt ?? new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(billingRefunds.id, row.id))
      .returning();
    row = updated ?? row;
  } else if (row.status === 'pending') {
    const [updated] = await tx
      .update(billingRefunds)
      .set({
        status: 'confirmed',
        amountRub: input.amountRub.toFixed(2),
        providerRefundId: row.providerRefundId ?? providerRefundId,
        providerStatus: input.providerStatus ?? row.providerStatus,
        confirmedAt: row.confirmedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(billingRefunds.id, row.id))
      .returning();
    row = updated ?? row;
  }
  return row;
}

type RefundProviderDisposition = 'confirmed' | 'pending' | 'rejected';

function refundProviderDisposition(payload: Record<string, unknown>): RefundProviderDisposition {
  const status = tochkaStatus(payload)?.toUpperCase();
  // For payment-link acquiring, Tochka documents REFUNDED and
  // REFUNDED_PARTIALLY as the refund-complete states. APPROVED is the original
  // payment state, while an acknowledgement such as ACCEPTED/COMPLETED is not
  // proof that the card refund has settled; treating it as final would revoke
  // access before money has moved.
  if (['REFUNDED', 'REFUNDED_PARTIALLY'].includes(status ?? '')) {
    return 'confirmed';
  }
  if (['REJECTED', 'DECLINED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(status ?? '')) {
    return 'rejected';
  }
  // Tochka uses ON-REFUND/WAITING (and occasionally omits status) while the
  // bank is processing. Absence is never proof that money moved.
  return 'pending';
}

function providerRefundIdFromPayload(payload: Record<string, unknown>): string | null {
  const operation = tochkaOperation(payload);
  // `operationId`/`id` in a refund response can be the parent payment id. The
  // refundUid is already the durable idempotency anchor; guessing a parent id
  // here would make a second legitimate partial refund collide in the ledger.
  return (
    (typeof operation.refundUid === 'string' && operation.refundUid) ||
    (typeof operation.RefundUid === 'string' && operation.RefundUid) ||
    (typeof operation.refundId === 'string' && operation.refundId) ||
    (typeof operation.RefundId === 'string' && operation.RefundId) ||
    (typeof operation.refundOperationId === 'string' && operation.refundOperationId) ||
    (typeof operation.RefundOperationId === 'string' && operation.RefundOperationId) ||
    (typeof operation.providerRefundId === 'string' && operation.providerRefundId) ||
    (typeof operation.ProviderRefundId === 'string' && operation.ProviderRefundId) ||
    (typeof payload.refundUid === 'string' && payload.refundUid) ||
    (typeof payload.RefundUid === 'string' && payload.RefundUid) ||
    (typeof payload.refundId === 'string' && payload.refundId) ||
    (typeof payload.RefundId === 'string' && payload.RefundId) ||
    (typeof payload.refundOperationId === 'string' && payload.refundOperationId) ||
    (typeof payload.RefundOperationId === 'string' && payload.RefundOperationId) ||
    (typeof payload.providerRefundId === 'string' && payload.providerRefundId) ||
    (typeof payload.ProviderRefundId === 'string' && payload.ProviderRefundId) ||
    null
  );
}

async function updateRefundRequest(
  id: string,
  patch: Partial<{
    status: 'pending' | 'confirmed' | 'applied' | 'rejected';
    providerRefundId: string | null;
    providerStatus: string | null;
    confirmedAt: Date | null;
    lastError: string | null;
  }>,
): Promise<void> {
  const status = patch.status;
  const allowedPreviousStatuses: RefundRow['status'][] | null =
    status === 'pending'
      ? ['pending', 'rejected']
      : status === 'rejected'
        ? ['pending', 'rejected']
        : status === 'confirmed'
          ? ['pending', 'rejected', 'confirmed']
          : status === 'applied'
            ? ['confirmed', 'applied']
            : null;
  await db
    .update(billingRefunds)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(billingRefunds.id, id),
        ...(allowedPreviousStatuses
          ? [inArray(billingRefunds.status, allowedPreviousStatuses)]
          : []),
      ),
    );
}

export async function reversePaymentGrant(
  opts: TochkaRefundReversal,
): Promise<{ orderId: string; clawedBack: number } | { ignored: 'unknown_payment' }> {
  const target = await resolveOrderRef(opts.paymentId, opts.orderRef);
  if (!target) return { ignored: 'unknown_payment' as const };
  return db.transaction(async (tx) => {
    // Settlement, media-retention promotion, and account erasure all share
    // this per-user lock. Reversal/error paths must take it too, otherwise a
    // clawback can race a payment settlement and expire media that was just
    // made permanent (or rewrite a subscription after it was revoked).
    await lockMediaStorageUser(tx, target.userId);
    const orderRows = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, target.id))
      .limit(1)
      .for('update');
    const order = orderRows[0];
    if (!order) return { ignored: 'unknown_payment' as const };
    // The metadata fallback can resolve an order before the provider payment
    // id is attached. Re-check under the same row lock so a concurrent payment
    // cannot be reversed against the wrong order; bind the verified provider
    // id here when the fallback was the path that found us.
    if (order.pspPaymentId && order.pspPaymentId !== opts.paymentId) {
      return { ignored: 'unknown_payment' as const };
    }
    if (!order.pspPaymentId) {
      await tx.update(orders).set({ pspPaymentId: opts.paymentId }).where(eq(orders.id, order.id));
    }

    // A cancellation is not a provider refund and has no refund-ledger row.
    // It can still race a payment success, so retain the old tombstone and
    // clawback semantics for this event type.
    if (opts.newStatus === 'failed') {
      if (order.ourStatus === 'pending') {
        await tx
          .update(orders)
          .set({ ourStatus: 'failed', pspStatus: 'failed' })
          .where(and(eq(orders.id, order.id), eq(orders.ourStatus, 'pending')));
        return { orderId: order.id, clawedBack: 0 };
      }
      if (order.ourStatus === 'failed') return { orderId: order.id, clawedBack: 0 };
      // A late cancellation notification must not downgrade a fully refunded
      // order back to `failed`; the refund is the stronger terminal fact and
      // its ledger/audit state must remain visible.
      if (order.ourStatus === 'refunded') return { orderId: order.id, clawedBack: 0 };
      if (!['paid', 'partially_refunded', 'refunded'].includes(order.ourStatus)) {
        return { orderId: order.id, clawedBack: 0 };
      }
      const granted = await credits.grantedForOrder(order.id, tx);
      const alreadyClawed = await credits.clawedBackForOrder(order.id, tx);
      const clawAmount = Math.max(0, granted - alreadyClawed);
      if (clawAmount > 0) {
        await credits.clawback({
          userId: order.userId,
          amount: clawAmount,
          reason: 'payment.cancel.clawback',
          idempotencyKey: opts.reversalKey,
          sourceOrderId: order.id,
          tx,
        });
      }
      await tx
        .update(orders)
        .set({ ourStatus: 'failed', pspStatus: 'failed' })
        .where(eq(orders.id, order.id));
      return { orderId: order.id, clawedBack: clawAmount };
    }

    // A confirmed refund is durable before any entitlement mutation. The row
    // remains `applied` even when the order was pending and no credits existed
    // yet; a later payment.succeeded is blocked by the order tombstone.
    const refund = await ensureConfirmedRefund(tx, {
      order: {
        id: order.id,
        psp: order.psp,
        pspPaymentId: opts.paymentId,
        amountRub: order.amountRub,
      },
      reversalKey: opts.reversalKey,
      ...(opts.refundUid !== undefined ? { refundUid: opts.refundUid } : {}),
      ...(opts.providerRefundId !== undefined ? { providerRefundId: opts.providerRefundId } : {}),
      amountRub: refundAmountRub(order.amountRub, opts.refundedRub),
      providerStatus: opts.providerStatus ?? 'REFUNDED',
    });
    if (refund.status === 'applied') return { orderId: order.id, clawedBack: 0 };

    const refundRows = await tx
      .select({ amountRub: billingRefunds.amountRub })
      .from(billingRefunds)
      .where(
        and(
          eq(billingRefunds.orderId, order.id),
          inArray(billingRefunds.status, ['confirmed', 'applied']),
        ),
      );
    const totalRefundedCents = refundRows.reduce(
      (sum, row) => sum + rubCents(Number(row.amountRub)),
      0,
    );
    const orderCents = rubCents(order.amountRub);
    const fullyRefunded = totalRefundedCents >= orderCents;

    if (order.ourStatus === 'pending') {
      await tx
        .update(orders)
        .set({
          ourStatus: fullyRefunded ? 'refunded' : 'partially_refunded',
          pspStatus: fullyRefunded ? 'refunded' : 'refunded_partially',
          refundedAt: new Date(),
        })
        .where(and(eq(orders.id, order.id), eq(orders.ourStatus, 'pending')));
      await tx
        .update(billingRefunds)
        .set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() })
        .where(eq(billingRefunds.id, refund.id));
      return { orderId: order.id, clawedBack: 0 };
    }
    if (!['paid', 'partially_refunded', 'refunded'].includes(order.ourStatus)) {
      // A legacy cancellation can leave an order in `failed` after its grant
      // was already clawed back. A later provider-confirmed refund still needs
      // a terminal ledger row; otherwise failed orders are outside the
      // reconciliation candidate set and the confirmed operation would remain
      // an unapplied dangling fact forever. There is no remaining entitlement
      // to revoke on this path, so recording the application is safe.
      await tx
        .update(billingRefunds)
        .set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() })
        .where(eq(billingRefunds.id, refund.id));
      return { orderId: order.id, clawedBack: 0 };
    }

    const granted = await credits.grantedForOrder(order.id, tx);
    let clawAmount = 0;
    if (granted > 0) {
      const fraction =
        orderCents > 0 ? Math.max(0, Math.min(1, totalRefundedCents / orderCents)) : 1;
      const alreadyClawed = await credits.clawedBackForOrder(order.id, tx);
      const remaining = Math.max(0, granted - alreadyClawed);
      const targetClawback = Math.round(granted * fraction);
      clawAmount = Math.min(Math.max(0, targetClawback - alreadyClawed), remaining);
      if (clawAmount > 0) {
        await credits.clawback({
          userId: order.userId,
          amount: clawAmount,
          reason: 'payment.refund.clawback',
          idempotencyKey: opts.reversalKey,
          sourceOrderId: order.id,
          tx,
        });
      }
    }
    await tx
      .update(orders)
      .set({
        ourStatus: fullyRefunded ? 'refunded' : 'partially_refunded',
        pspStatus: fullyRefunded ? 'refunded' : 'refunded_partially',
        refundedAt: new Date(),
      })
      .where(eq(orders.id, order.id));
    await tx
      .update(billingRefunds)
      .set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() })
      .where(eq(billingRefunds.id, refund.id));
    // A full reversal of the initial subscription payment revokes the plan it
    // created. The subscription id is bound into the order metadata at
    // settlement, so a refund cannot accidentally cancel a different row for
    // the same user. Partial refunds leave access unchanged; support can then
    // decide the commercial remedy without turning a fractional refund into a
    // full entitlement loss.
    const orderMeta = (order.metadata as OrderMetadata) ?? {};
    const fullReversal = fullyRefunded;
    if (
      order.kind === 'subscription' &&
      fullReversal &&
      orderMeta.purpose === 'subscribe' &&
      orderMeta.subscriptionId
    ) {
      const revoked = await tx
        .update(subscriptions)
        .set({ status: 'canceled', cancelAtPeriodEnd: true })
        .where(
          and(
            eq(subscriptions.id, orderMeta.subscriptionId),
            eq(subscriptions.userId, order.userId),
            inArray(subscriptions.status, ['active', 'trialing', 'past_due']),
          ),
        )
        .returning({ id: subscriptions.id });
      if (revoked.length > 0 && !(await hasPaidMediaStorage(tx, order.userId, new Date()))) {
        await tx
          .update(galleryItems)
          .set({ expiresAt: mediaExpiresAt(false) })
          .where(
            and(
              eq(galleryItems.userId, order.userId),
              isNull(galleryItems.deletedAt),
              isNull(galleryItems.expiresAt),
            ),
          );
      }
    }
    if (
      order.kind === 'pack' &&
      fullReversal &&
      !(await hasPaidMediaStorage(tx, order.userId, new Date()))
    ) {
      await tx
        .update(galleryItems)
        .set({ expiresAt: mediaExpiresAt(false) })
        .where(
          and(
            eq(galleryItems.userId, order.userId),
            isNull(galleryItems.deletedAt),
            isNull(galleryItems.expiresAt),
          ),
        );
    }
    return { orderId: order.id, clawedBack: clawAmount };
  });
}

export function setupBillingRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  app.get('/v1/billing/packs', async () => {
    const rows = await db
      .select({
        id: creditPacks.id,
        credits: creditPacks.credits,
        priceRub: creditPacks.priceRub,
        title: creditPacks.title,
        description: creditPacks.description,
        sortOrder: creditPacks.sortOrder,
      })
      .from(creditPacks)
      .where(eq(creditPacks.isActive, true))
      .orderBy(creditPacks.sortOrder);
    return rows;
  });

  app.post(
    '/v1/billing/checkout',
    { config: { rateLimit: CHECKOUT_RATE_LIMIT } },
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = checkoutSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const livePlan = await resolveLivePlanSubscription(db, session.user.id);
      if (!livePlan) {
        return reply.status(403).send({ error: 'active_subscription_required' });
      }
      const packRows = await db
        .select()
        .from(creditPacks)
        .where(eq(creditPacks.id, parsed.data.packId))
        .limit(1);
      const pack = packRows[0];
      if (!pack || !pack.isActive) {
        return reply.status(400).send({ error: 'pack_not_available' });
      }

      const provider = getPaymentProvider();
      if (provider.kind === 'yookassa' && provider.adapter.mode === 'stub' && isProd) {
        req.log.error({}, 'billing: stub mode in production — refusing');
        return reply.status(500).send({ error: 'psp_not_configured' });
      }

      // W1-0 — intent-first: claim the subject and persist the order BEFORE the
      // PSP is called, so a concurrent double-submit can never mint a second
      // payment. Nothing is locked across the HTTP call that follows.
      const intentOrderId = nid();
      const intent = await acquireBillingIntent(
        {
          id: intentOrderId,
          userId: session.user.id,
          kind: 'pack',
          tierOrPackId: pack.id,
          amountRub: pack.priceRub,
          psp:
            provider.kind === 'tochka'
              ? 'tochka'
              : provider.adapter.mode === 'stub'
                ? 'yookassa-stub'
                : 'yookassa',
          ourStatus: 'pending',
          ...(provider.kind === 'tochka' ? { metadata: { paymentLinkId: intentOrderId } } : {}),
          intentKey: packIntentKey(pack.id),
        },
        {
          probe: async (id) => {
            if (provider.kind === 'yookassa') return provider.adapter.retrievePayment(id);
            try {
              const info = await provider.adapter.getPaymentInfo(id);
              return { status: tochkaStatus(info) ?? 'unknown' };
            } catch {
              return null;
            }
          },
        },
      );
      if (!intent.ok) {
        req.log.info(
          { userId: session.user.id, packId: pack.id, existingOrderId: intent.existingOrderId },
          'billing: checkout already in progress',
        );
        return reply
          .status(409)
          .send({ error: 'checkout_in_progress', orderId: intent.existingOrderId });
      }
      // Price from the ORDER, never from a re-read catalog: on a resume the
      // idempotency key returns the original payment, so charging a newly-read
      // price would be a lie.
      const { orderId, amountRub } = intent;

      const returnUrl = `${WEB_PUBLIC_URL}/billing/return?orderId=${orderId}`;
      const contact = await customerContactFor(session.user.id);
      const customerEmail = contact.email ?? parsed.data.customerEmail ?? null;
      let payment: { confirmationUrl: string; providerPaymentId: string; status: string };
      try {
        if (provider.kind === 'tochka') {
          const created = await provider.adapter.createPayment({
            amountRub,
            orderId,
            kind: 'pack',
            purpose: `Покупка пакета ${pack.title}`,
            returnUrl,
            customerEmail,
            customerPhone: contact.phone,
            itemTitle: pack.title ?? `Пакет токенов ${pack.id}`,
          });
          payment = {
            confirmationUrl: created.confirmationUrl,
            providerPaymentId: created.providerPaymentId,
            status: created.status,
          };
        } else {
          payment = await provider.adapter.createPayment({
            amountRub,
            orderId,
            userId: session.user.id,
            itemId: pack.id,
            kind: 'pack',
            returnUrl,
            description: `Credit pack ${pack.id} for user ${session.user.id}`,
            customerEmail,
            customerPhone: contact.phone,
            receiptDescription: pack.title ?? `Пакет токенов ${pack.id}`,
          });
        }
      } catch (err) {
        // Release ONLY on a proven refusal. On a timeout or an unparseable
        // success the payment may exist, and freeing the subject there is exactly
        // how the customer ends up with two live payments for one purchase.
        const outcome = createFailureOutcomeOf(err);
        if (outcome === 'rejected') await releaseBillingIntent(orderId);
        req.log.error(
          { err, orderId, outcome, intentHeld: outcome !== 'rejected' },
          'billing: yookassa create failed',
        );
        return reply.status(502).send({ error: 'psp_unavailable' });
      }
      await attachPspPayment(orderId, payment).catch((err: unknown) => {
        // The payment exists at the PSP and the buyer must be able to reach it.
        // A failed attach is recoverable — the webhook resolves by the order id
        // in the payment's metadata — so never turn it into a failed checkout.
        req.log.error({ err, orderId }, 'billing: psp payment attach failed');
      });
      req.log.info(
        {
          orderId,
          packId: pack.id,
          userId: session.user.id,
          provider: provider.kind,
          resumed: intent.resumed,
        },
        'billing: created checkout',
      );
      return reply.status(201).send({ orderId, confirmationUrl: payment.confirmationUrl });
    },
  );

  app.post('/v1/admin/billing/refund', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    if (!isAdminUser(session.user.id)) return reply.status(403).send({ error: 'forbidden' });
    const parsed = refundSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const provider = getPaymentProvider();
    if (provider.kind !== 'tochka') return reply.status(409).send({ error: 'provider_not_tochka' });
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, parsed.data.orderId))
      .limit(1);
    if (!order || order.psp !== 'tochka' || !order.pspPaymentId)
      return reply.status(404).send({ error: 'payment_not_found' });
    if (parsed.data.amountRub !== undefined && !parsed.data.refundUid) {
      return reply.status(400).send({ error: 'refund_uid_required_for_partial' });
    }
    // Full refunds can be safely retried with a deterministic key. Partial
    // refunds require an explicit caller-generated refundUid so two legitimate
    // equal-amount refunds do not collapse into one PSP/clawback operation.
    const requestedUid =
      parsed.data.refundUid ??
      `seed-refund-${createHash('sha256').update(`${order.id}:full`).digest('hex').slice(0, 32)}`;
    // Once the local reversal has committed, the order is `refunded`. Treat a
    // repeat of the deterministic full-refund request as an idempotent success
    // instead of forcing the admin to interpret a 409 as a failed refund. The
    // row must belong to this exact order/payment and be applied; a pending or
    // confirmed row still needs the normal provider/reconciliation path below.
    if (!['paid', 'partially_refunded'].includes(order.ourStatus)) {
      if (order.ourStatus === 'refunded' && parsed.data.amountRub === undefined) {
        const [existing] = await db
          .select()
          .from(billingRefunds)
          .where(
            and(
              eq(billingRefunds.psp, 'tochka'),
              eq(billingRefunds.orderId, order.id),
              eq(billingRefunds.pspPaymentId, order.pspPaymentId),
              eq(billingRefunds.refundUid, requestedUid),
              eq(billingRefunds.status, 'applied'),
            ),
          )
          .limit(1);
        if (existing) {
          return {
            ok: true,
            orderId: order.id,
            status: 'confirmed',
            result: { status: 'REFUNDED' },
          };
        }
      }
      return reply.status(409).send({ error: 'payment_not_approved' });
    }
    let request: RefundRow | undefined;
    let providerConfirmed = false;
    try {
      request = await db.transaction(async (tx) => {
        await lockMediaStorageUser(tx, order.userId);
        const [locked] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, order.id))
          .limit(1)
          .for('update');
        if (!locked || !['paid', 'partially_refunded'].includes(locked.ourStatus)) {
          throw new Error('payment_not_approved');
        }
        // Check the idempotency row before reserving the requested amount.
        // A retry of a WAITING request must be allowed to ask Tochka for the
        // same UID again; counting that row as a fresh reservation would make
        // an otherwise valid retry fail with refund_exceeds_payment.
        const [existing] = await tx
          .select()
          .from(billingRefunds)
          .where(and(eq(billingRefunds.psp, 'tochka'), eq(billingRefunds.refundUid, requestedUid)))
          .limit(1)
          .for('update');
        if (existing) {
          if (existing.orderId !== locked.id || existing.pspPaymentId !== locked.pspPaymentId) {
            throw new Error('refund_uid_conflict');
          }
          if (
            parsed.data.amountRub !== undefined &&
            Number(existing.amountRub) !== parsed.data.amountRub
          ) {
            throw new Error('refund_uid_conflict');
          }
          return existing;
        }
        const refundRows = await tx
          .select({ amountRub: billingRefunds.amountRub, status: billingRefunds.status })
          .from(billingRefunds)
          .where(eq(billingRefunds.orderId, order.id));
        const reservedCents = refundRows
          .filter((row) => row.status !== 'rejected')
          .reduce((sum, row) => sum + rubCents(Number(row.amountRub)), 0);
        const requestedCents =
          parsed.data.amountRub !== undefined
            ? Math.max(1, rubCents(parsed.data.amountRub))
            : Math.max(1, rubCents(locked.amountRub) - reservedCents);
        if (requestedCents > rubCents(locked.amountRub) - reservedCents) {
          throw new Error('refund_exceeds_payment');
        }
        const amountRub = requestedCents / 100;
        const [inserted] = await tx
          .insert(billingRefunds)
          .values({
            id: nid(),
            psp: 'tochka',
            orderId: locked.id,
            pspPaymentId: locked.pspPaymentId!,
            refundUid: requestedUid,
            amountRub: amountRub.toFixed(2),
            status: 'pending',
            requestedAt: new Date(),
            updatedAt: new Date(),
          })
          .returning();
        if (!inserted) throw new Error('refund request insert failed');
        return inserted;
      });
      if (!request) throw new Error('refund request insert failed');
      if (request.status === 'applied') {
        return { ok: true, orderId: order.id, status: 'confirmed', result: { status: 'REFUNDED' } };
      }
      const result =
        request.status === 'confirmed'
          ? ({ status: 'REFUNDED' } as Record<string, unknown>)
          : await provider.adapter.refundPayment(
              order.pspPaymentId,
              Number(request.amountRub) >= order.amountRub &&
                Number(request.amountRub) === order.amountRub
                ? undefined
                : Number(request.amountRub),
              requestedUid,
            );
      const providerStatus = tochkaStatus(result)?.toUpperCase() ?? 'WAITING';
      const disposition = refundProviderDisposition(result);
      providerConfirmed = request.status === 'confirmed' || disposition === 'confirmed';
      await updateRefundRequest(request.id, {
        status: disposition,
        providerRefundId: providerRefundIdFromPayload(result),
        providerStatus,
        ...(disposition === 'confirmed' ? { confirmedAt: new Date() } : {}),
        ...(disposition === 'rejected' ? { lastError: `provider status ${providerStatus}` } : {}),
      });
      if (disposition !== 'confirmed') {
        req.log.info(
          { orderId: order.id, result, refundUid: requestedUid, disposition },
          'billing: Tochka refund request recorded',
        );
        return {
          ok: disposition === 'pending',
          orderId: order.id,
          status: disposition,
          result,
        };
      }
      const out = await reversePaymentGrant({
        paymentId: order.pspPaymentId,
        orderRef: order.id,
        reversalKey: `clawback:tochka:refund:${requestedUid}`,
        refundUid: requestedUid,
        providerRefundId: providerRefundIdFromPayload(result),
        providerStatus,
        newStatus: 'refunded',
        refundedRub: Number(request.amountRub),
      });
      req.log.info({ orderId: order.id, result, out }, 'billing: Tochka manual refund confirmed');
      return { ok: true, orderId: order.id, status: 'confirmed', result };
    } catch (err) {
      if (err instanceof Error && err.message === 'payment_not_approved') {
        return reply.status(409).send({ error: 'payment_not_approved' });
      }
      if (err instanceof Error && err.message === 'refund_exceeds_payment') {
        return reply.status(400).send({ error: 'refund_exceeds_payment' });
      }
      if (err instanceof Error && err.message === 'refund_uid_conflict') {
        return reply.status(409).send({ error: 'refund_uid_conflict' });
      }
      if (request && !providerConfirmed) {
        await updateRefundRequest(request.id, {
          status: 'pending',
          lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
        }).catch(() => {});
      }
      req.log.error({ err, orderId: order.id }, 'billing: Tochka refund failed');
      return reply.status(502).send({ error: 'refund_failed' });
    }
  });

  app.post('/v1/billing/webhook', async (req, reply) => {
    const provider = getPaymentProvider();
    if (provider.kind === 'tochka') {
      const rawBody = req.rawBody
        ? req.rawBody.toString('utf-8')
        : typeof req.body === 'string'
          ? req.body
          : '';
      const verdict = await provider.adapter.verifyWebhook({ rawBody });
      if (!verdict.ok || !verdict.payload) {
        req.log.warn({ reason: verdict.reason }, 'billing: Tochka webhook auth rejected');
        // Acknowledge malformed probes/retries without applying anything. Tochka
        // tests endpoint reachability during webhook registration and retries
        // deliveries when it does not receive HTTP 200. Authenticity is still
        // fail-closed for side effects: only a verified payload can settle an order.
        return reply.status(200).send({ ok: true, ignored: 'invalid_webhook' });
      }
      const payload = verdict.payload;
      const operation = tochkaOperation(payload);
      const paymentId =
        (typeof operation.operationId === 'string' && operation.operationId) ||
        (typeof operation.id === 'string' && operation.id) ||
        (typeof operation.paymentUid === 'string' && operation.paymentUid) ||
        (typeof payload.operationId === 'string' && payload.operationId) ||
        undefined;
      const paymentLinkId =
        (typeof operation.paymentLinkId === 'string' && operation.paymentLinkId) ||
        (typeof operation.orderUid === 'string' && operation.orderUid) ||
        (typeof payload.paymentLinkId === 'string' && payload.paymentLinkId) ||
        (typeof payload.orderUid === 'string' && payload.orderUid) ||
        undefined;
      const status = tochkaStatus(payload);
      const normalizedStatus = status?.toUpperCase();
      if (!paymentId && !paymentLinkId)
        return reply.status(400).send({ error: 'missing_payment_id' });

      // A refund notification can contain our paymentLinkId while omitting the
      // provider operation id. Never pass the local link into reversePaymentGrant:
      // that would bind orders.pspPaymentId to our own order id and permanently
      // hide the real payment from operation-list reconciliation. Park the
      // authenticated event with a stable key instead; the next reconciliation
      // tick resolves the real PSP id by paymentLinkId before applying the refund.
      if (
        !paymentId &&
        paymentLinkId &&
        (normalizedStatus === 'REFUNDED' || normalizedStatus === 'REFUNDED_PARTIALLY')
      ) {
        const attempts = await retainUnresolvedEvent({
          event: 'tochka.refund',
          objectId: tochkaUnboundRefundEventKey(paymentLinkId, normalizedStatus),
          pspPaymentId: null,
          orderRef: paymentLinkId,
          payload: payload as Record<string, unknown>,
        });
        req.log.warn(
          { paymentLinkId, attempts },
          'billing: Tochka refund missing provider payment id — retained for reconciliation',
        );
        return unresolvedReply(reply, attempts, 'missing provider payment id');
      }

      const correlationId = paymentId ?? paymentLinkId!;
      if (tochkaSuccessfulStatus(status)) {
        try {
          await applyPaymentSucceeded(correlationId, paymentLinkId);
          await dropUnresolvedEvent('tochka.acquiringInternetPayment', correlationId).catch(
            () => {},
          );
        } catch (err) {
          const reason =
            err instanceof UnsettleableOrderError
              ? err.reason
              : err instanceof UnknownPaymentError
                ? 'no local order for this payment'
                : 'payment settlement failed';
          const attempts = await retainUnresolvedEvent({
            event: 'tochka.acquiringInternetPayment',
            objectId: correlationId,
            pspPaymentId: paymentId ?? null,
            orderRef: paymentLinkId ?? null,
            payload: payload as Record<string, unknown>,
          });
          req.log.error(
            { err, paymentId, paymentLinkId, reason, attempts },
            'billing: Tochka payment not settled — retained for reconciliation',
          );
          return unresolvedReply(reply, attempts, reason);
        }
      } else if (normalizedStatus === 'REFUNDED' || normalizedStatus === 'REFUNDED_PARTIALLY') {
        const refunds = tochkaRefundEntries(payload, operation, normalizedStatus, correlationId);
        if (refunds.length === 0) {
          const reversalKey = tochkaRefundKey(payload, operation, correlationId, normalizedStatus);
          const attempts = await retainUnresolvedEvent({
            event: 'tochka.refund',
            objectId: reversalKey,
            pspPaymentId: paymentId ?? correlationId,
            orderRef: paymentLinkId ?? null,
            payload: payload as Record<string, unknown>,
          });
          req.log.error(
            { paymentId, paymentLinkId, attempts },
            'billing: Tochka refund has no stable operation id — retained',
          );
          return unresolvedReply(reply, attempts, 'missing stable refund identifier');
        }
        for (const refund of refunds) {
          const reversalKey = `clawback:tochka:${correlationId}:${refund.id}`;
          try {
            const refundUid = refund.refundUid ?? refund.id;
            const out = await reversePaymentGrant({
              paymentId: correlationId,
              // Tochka assigns a distinct id to each refund row. Use that id
              // for the ledger and clawback so equal partials stay separate.
              reversalKey,
              refundUid,
              providerRefundId: refund.providerRefundId ?? refund.id,
              providerStatus: normalizedStatus,
              newStatus: 'refunded',
              ...(paymentLinkId ? { orderRef: paymentLinkId } : {}),
              ...(refund.amountRub != null ? { refundedRub: refund.amountRub } : {}),
            });
            if ('ignored' in out) {
              const attempts = await retainUnresolvedEvent({
                event: 'tochka.refund',
                objectId: reversalKey,
                pspPaymentId: paymentId ?? correlationId,
                orderRef: paymentLinkId ?? null,
                payload: payload as Record<string, unknown>,
              });
              return unresolvedReply(reply, attempts, 'no local order for this refund');
            }
            await dropUnresolvedEvent('tochka.refund', reversalKey).catch(() => {});
          } catch (err) {
            const attempts = await retainUnresolvedEvent({
              event: 'tochka.refund',
              objectId: reversalKey,
              pspPaymentId: paymentId ?? correlationId,
              orderRef: paymentLinkId ?? null,
              payload: payload as Record<string, unknown>,
            });
            req.log.error(
              { err, paymentId, paymentLinkId, refundId: refund.id, attempts },
              'billing: Tochka refund reversal failed — retained for reconciliation',
            );
            return unresolvedReply(reply, attempts, 'refund reversal failed');
          }
        }
      }
      return { ok: true, status };
    }
    // SF-2: optional source-IP allow-list (defense-in-depth on top of the
    // shared Bearer). Enforced only when YOOKASSA_WEBHOOK_IPS is configured.
    const ipAllowlist = webhookIpAllowlist();
    if (ipAllowlist && !isAllowedWebhookIp(req.ip, ipAllowlist)) {
      req.log.warn({ ip: req.ip }, 'billing: webhook from non-allowlisted IP');
      return reply.status(401).send({ error: 'unauthorized' });
    }
    // #8 audit: prefer the raw bytes captured by the preParsing hook so
    // verifyWebhook can validate a future HMAC signature on the exact
    // original payload. Fall back to JSON-serialised body for tests that
    // inject a pre-parsed object directly (e.g. Fastify inject()).
    const rawBodyStr = req.rawBody
      ? req.rawBody.toString('utf-8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {});
    const verdict = getAdapter().verifyWebhook({
      rawBody: rawBodyStr,
      headers: req.headers,
    });
    if (!verdict.ok) {
      req.log.warn({ ip: req.ip, reason: verdict.reason }, 'billing: webhook auth rejected');
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const body = req.body as { event?: string; object?: Record<string, unknown> } | undefined;
    if (!body?.event || !body.object) {
      return reply.status(400).send({ error: 'invalid_body' });
    }
    const payment = body.object as { id?: string; status?: string };
    if (!payment.id) return reply.status(400).send({ error: 'missing_payment_id' });
    // The order id we sent to the PSP comes back on the payment object. It is
    // the second way to attribute an event, and the one that works while the
    // provider's payment id has not been written to the order row yet.
    const orderRef = orderRefFromEvent(body.object);

    if (body.event === 'payment.succeeded') {
      try {
        const out = await applyPaymentSucceeded(payment.id, orderRef);
        req.log.info({ paymentId: payment.id, orderId: out.orderId }, 'billing: webhook applied');
        await dropUnresolvedEvent(body.event, payment.id).catch(() => {});
        return { ok: true };
      } catch (err) {
        // Two different "we will not settle this": we could not attribute the
        // payment at all, or we attributed it and refused to act (unverifiable
        // against the PSP, bound to another payment, stale upgrade baseline).
        // Both must be RETAINED, never acked away — the money is real either
        // way, and canon §5's complaint is precisely that it vanished.
        if (err instanceof UnknownPaymentError || err instanceof UnsettleableOrderError) {
          const reason =
            err instanceof UnsettleableOrderError ? err.reason : 'no local order for this payment';
          const attempts = await retainUnresolvedEvent({
            event: body.event,
            objectId: payment.id,
            pspPaymentId: payment.id,
            orderRef,
            payload: body as Record<string, unknown>,
          });
          req.log.error(
            { paymentId: payment.id, orderRef, reason, attempts },
            'billing: webhook not settled — retained for reconciliation',
          );
          return unresolvedReply(reply, attempts, reason);
        }
        req.log.error({ err, paymentId: payment.id }, 'billing: webhook apply failed');
        return reply.status(500).send({ error: 'apply_failed' });
      }
    }
    if (body.event === 'payment.canceled' || body.event === 'refund.succeeded') {
      // BL-14: a `refund.succeeded` object is a REFUND (its `id` is the refund
      // id; the payment is in `payment_id`). A `payment.canceled` object is the
      // payment itself. Resolve the order by the PAYMENT id either way.
      const isRefund = body.event === 'refund.succeeded';
      const refundObj = body.object as {
        id?: string;
        payment_id?: string;
        amount?: { value?: string | number };
      };
      const orderPaymentId = isRefund ? (refundObj.payment_id ?? payment.id) : payment.id;
      const newStatus = isRefund ? ('refunded' as const) : ('failed' as const);
      // Partial-refund support: a full refund or a cancel reverses the whole
      // grant (keyed by order, so cancel+full-refund can't double-claw); a
      // partial refund reverses its share (keyed by the refund id).
      const refundedRub =
        isRefund && refundObj.amount?.value != null ? Number(refundObj.amount.value) : undefined;
      const partial = refundedRub != null; // YooKassa always sends amount on refunds
      const reversalKey =
        partial && refundObj.id
          ? `clawback:refund:${refundObj.id}`
          : `clawback:order-payment:${orderPaymentId}`;
      try {
        const out = await reversePaymentGrant({
          paymentId: orderPaymentId,
          // A refund object carries the refund's own metadata, not the
          // payment's — only a `payment.canceled` object is our payment.
          orderRef: isRefund ? null : orderRef,
          reversalKey,
          newStatus,
          ...(isRefund && refundObj.id
            ? {
                refundUid: refundObj.id,
                providerRefundId: refundObj.id,
                providerStatus: 'succeeded',
              }
            : {}),
          ...(refundedRub != null ? { refundedRub } : {}),
        });
        if ('ignored' in out) {
          const attempts = await retainUnresolvedEvent({
            event: body.event,
            objectId: payment.id,
            pspPaymentId: orderPaymentId,
            orderRef: isRefund ? null : orderRef,
            payload: body as Record<string, unknown>,
          });
          req.log.error(
            { paymentId: orderPaymentId, event: body.event, attempts },
            'billing: reversal could not be attributed to an order — retained',
          );
          return unresolvedReply(reply, attempts, 'no local order for this payment');
        }
        req.log.info({ paymentId: orderPaymentId, event: body.event, out }, 'billing: reversal');
        await dropUnresolvedEvent(body.event, payment.id).catch(() => {});
        return { ok: true };
      } catch (err) {
        req.log.error({ err, paymentId: orderPaymentId }, 'billing: reversal failed');
        return reply.status(500).send({ error: 'reversal_failed' });
      }
    }
    return { ok: true, ignored: body.event };
  });

  app.get<{ Querystring: { orderId?: string; forceSuccess?: string } }>(
    '/v1/billing/return',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const orderId = req.query.orderId;
      if (!orderId) return reply.status(400).send({ error: 'missing_order_id' });

      const rows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      const order = rows[0];
      if (!order || order.userId !== session.user.id) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const activeProvider = getPaymentProvider();
      if (
        req.query.forceSuccess === '1' &&
        activeProvider.kind === 'yookassa' &&
        activeProvider.adapter.mode === 'stub' &&
        !isProd &&
        order.ourStatus === 'pending' &&
        order.pspPaymentId
      ) {
        try {
          await applyPaymentSucceeded(order.pspPaymentId);
        } catch (err) {
          req.log.error({ err, orderId }, 'billing: forceSuccess apply failed');
        }
      }

      const fresh = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      const final = fresh[0]!;
      // Live provider status, reused below for the resume link — no second
      // provider call. Stays undefined for non-Tochka orders and when the
      // reconciliation lookup itself fails.
      let tochkaLiveStatus: string | undefined;
      if (activeProvider.kind === 'tochka' && final.ourStatus === 'pending' && final.pspPaymentId) {
        try {
          const info = await activeProvider.adapter.getPaymentInfo(final.pspPaymentId);
          tochkaLiveStatus = tochkaStatus(info);
          if (tochkaSuccessfulStatus(tochkaLiveStatus)) {
            await applyPaymentSucceeded(final.pspPaymentId, orderId);
            const refreshed = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
            if (refreshed[0]) Object.assign(final, refreshed[0]);
          }
        } catch (err) {
          req.log.warn({ err, orderId }, 'billing: Tochka status reconciliation failed');
        }
      }
      // For pack orders we surface the granted credits inline so the
      // /billing/return UI can show "+200 credits"; for subscription
      // orders the credits live on the subscription_grant ledger row
      // and the UI fetches /v1/billing/subscription separately.
      let creditsGranted = 0;
      if (final.ourStatus === 'paid' && final.kind === 'pack') {
        const packRows = await db
          .select({ credits: creditPacks.credits })
          .from(creditPacks)
          .where(eq(creditPacks.id, final.tierOrPackId))
          .limit(1);
        creditsGranted = packRows[0]?.credits ?? 0;
      } else if (final.ourStatus === 'paid' && final.kind === 'subscription') {
        const meta = (final.metadata as OrderMetadata) ?? {};
        if (meta.purpose === 'subscribe' || !meta.purpose) {
          const subRows = await db
            .select({ creditsPerCycle: subscriptions.creditsPerCycle })
            .from(subscriptions)
            .where(eq(subscriptions.userId, final.userId))
            .orderBy(subscriptions.createdAt)
            .limit(1);
          creditsGranted = subRows[0]?.creditsPerCycle ?? 0;
        }
      }
      return {
        orderId,
        kind: final.kind,
        amountRub: final.amountRub,
        status: final.ourStatus,
        creditsGranted,
        // Resume link for a still-payable pending order (bounced Tochka form).
        // Paid/failed/dead rows get null — never offer resume there. Computed
        // from the live status fetched above; no new provider calls.
        resumeUrl: resumeUrlForOrder(final, tochkaLiveStatus),
      };
    },
  );
}

export const _internal = {
  _setAdapter,
  _setTochkaAdapter,
  applyPaymentSucceeded,
  reversePaymentGrant,
  resumeUrlForOrder,
  RESUMABLE_TOCHKA_STATUSES,
  tochkaUnboundRefundEventKey,
  tochkaRefundKey,
  tochkaRefundEntries,
  UnknownPaymentError,
  UnsettleableOrderError,
  MAX_UNRESOLVED_RETRY_ATTEMPTS,
  CYCLE_DAYS,
  CYCLE_MS,
};

/** Subscription endpoints — split file consumes this for tier lookups. */
export const _billingShared = {
  getAdapter,
  getPaymentProvider,
  applyPaymentSucceeded,
  customerContactFor,
  isProd,
  WEB_PUBLIC_URL,
};
