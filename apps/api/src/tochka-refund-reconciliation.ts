import { randomUUID } from 'node:crypto';
import type IORedis from 'ioredis';
import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { billingRefunds, billingUnresolvedEvents, db, orders, subscriptions } from '@seed/db';
import {
  _billingShared,
  reversePaymentGrant,
  tochkaUnboundRefundEventKey,
  type TochkaRefundReversal,
} from './billing';
import { tochkaReconciliationFailuresTotal, tochkaReconciliationLastSuccess } from './metrics';
import { createTochkaProvider, type TochkaPaymentProvider } from '@seed/provider-tochka';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
const LEADER_KEY = 'seed:tochka-refund-reconciliation:leader';

type ReconciliationProvider = Pick<
  TochkaPaymentProvider,
  'getPaymentInfo' | 'getSubscriptionStatus' | 'setSubscriptionStatus'
> &
  Partial<Pick<TochkaPaymentProvider, 'getPaymentOperationList'>>;

type TochkaOperation = Record<string, unknown>;
type ReconcileCandidate = {
  id: string;
  userId: string;
  kind: 'subscription' | 'pack';
  amountRub: number;
  pspPaymentId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  ourStatus: 'pending' | 'paid' | 'partially_refunded' | 'refunded' | 'failed';
};

export interface TochkaRefundOperation {
  /** Stable refund identity (UID when present, otherwise `Order[].orderId`). */
  id: string;
  amountRub?: number;
  /** Provider refund UID when it is distinct from the operation id. */
  refundUid?: string;
  /** Parent row's provider id when the UID is used as the identity. */
  providerRefundId?: string;
}

type RefundObservationDisposition = 'confirmed' | 'pending' | 'rejected';
type RefundObservation = TochkaRefundOperation & {
  disposition: RefundObservationDisposition;
  providerStatus: string;
};
type RefundLedgerRow = typeof billingRefunds.$inferSelect;

export interface TochkaRefundReconciliationOptions {
  provider: ReconciliationProvider;
  /** Retained for API compatibility; reconciliation is no longer time-limited. */
  now?: Date;
  lookbackMs?: number;
  batchSize?: number;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Lease fencing hook supplied by the leader loop. */
  beforeProviderCall?: () => Promise<void>;
}

export interface TochkaRefundReconciliationResult {
  checked: number;
  refunded: number;
  clawedBack: number;
  providerCancellations: number;
  failures: number;
}

export interface TochkaRefundReconciliationHandle {
  stop(): void;
  tick(): Promise<TochkaRefundReconciliationResult>;
}

function operationFrom(payload: Record<string, unknown>): TochkaOperation {
  const nested = (payload.Data ?? payload.data ?? payload) as Record<string, unknown>;
  if (Array.isArray(nested.Operation)) {
    return (nested.Operation[0] as TochkaOperation | undefined) ?? {};
  }
  return nested;
}

function operationsFrom(payload: Record<string, unknown>): TochkaOperation[] {
  const nested = (payload.Data ?? payload.data ?? payload) as Record<string, unknown>;
  const rows = nested.Operation ?? nested.Operations ?? payload.Operation ?? payload.Operations;
  if (Array.isArray(rows)) {
    return rows.filter((row): row is TochkaOperation => !!row && typeof row === 'object');
  }
  if (rows && typeof rows === 'object') return [rows as TochkaOperation];
  return Object.keys(nested).length > 0 ? [nested] : [];
}

function stringField(operation: TochkaOperation, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = operation[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function numberField(operation: TochkaOperation, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = operation[name];
    const value =
      raw && typeof raw === 'object'
        ? ((raw as Record<string, unknown>).amount ??
          (raw as Record<string, unknown>).Amount ??
          (raw as Record<string, unknown>).value ??
          (raw as Record<string, unknown>).Value)
        : raw;
    const number =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

function positiveInt(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function rubCents(value: number): number {
  return Math.round(value * 100);
}

function statusFrom(payload: Record<string, unknown>, operation: TochkaOperation): string {
  const raw = operation.status ?? operation.Status ?? payload.status ?? payload.Status;
  if (raw && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>).value ?? (raw as Record<string, unknown>).Value;
    return typeof value === 'string' ? value.toUpperCase() : '';
  }
  return typeof raw === 'string' ? raw.toUpperCase() : '';
}

function operationPaymentId(operation: TochkaOperation): string | undefined {
  return stringField(operation, 'operationId', 'OperationId', 'paymentUid', 'paymentId', 'id');
}

function operationPaymentLinkId(operation: TochkaOperation): string | undefined {
  return stringField(operation, 'paymentLinkId', 'PaymentLinkId', 'orderUid', 'orderId');
}

function providerRefundUid(
  operation: TochkaOperation,
  payload: Record<string, unknown>,
): string | undefined {
  return (
    stringField(operation, 'refundUid', 'RefundUid', 'refundId', 'RefundId', 'refundOperationId') ??
    stringField(payload, 'refundUid', 'refundId', 'refundOperationId')
  );
}

function refundDisposition(status: string): RefundObservationDisposition | null {
  // Tochka's payment-link acquiring API defines these two statuses as refund
  // completion. Other seemingly-successful states (APPROVED, ACCEPTED,
  // COMPLETED, SUCCEEDED) describe a payment or an acknowledgement, not proof
  // that the card refund has settled.
  if (['REFUNDED', 'REFUNDED_PARTIALLY'].includes(status)) {
    return 'confirmed';
  }
  if (['REJECTED', 'DECLINED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(status)) {
    return 'rejected';
  }
  if (['WAITING', 'ON-REFUND', 'ON_REFUND', 'PENDING', 'PROCESSING'].includes(status)) {
    return 'pending';
  }
  return null;
}

/**
 * Keep the provider's refund state visible even when it is not final. The
 * public extractor intentionally returns only confirmed operations for the
 * credit-reversal path; reconciliation also needs WAITING/REJECTED so a
 * pending admin request cannot remain pending forever after the bank refuses
 * it.
 */
function observeTochkaRefunds(
  payload: Record<string, unknown>,
  paymentId: string,
  orderAmountRub: number,
): RefundObservation[] {
  const operation = operationFrom(payload);
  const topStatus = statusFrom(payload, operation);
  const rows = operation.Order ?? operation.order;
  if (Array.isArray(rows)) {
    const observations: RefundObservation[] = [];
    const seen = new Set<string>();
    let missingAmount = false;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const entry = row as Record<string, unknown>;
      const type = String(entry.type ?? entry.Type ?? '').toLowerCase();
      if (type !== 'refund') continue;
      const uid = stringField(entry, 'refundUid', 'RefundUid', 'refundId', 'RefundId');
      const providerRefundId = stringField(
        entry,
        'providerRefundId',
        'ProviderRefundId',
        'refundOperationId',
        'RefundOperationId',
        'orderId',
        'OrderId',
      );
      const explicitRowId = stringField(entry, 'id', 'Id');
      const fallbackId = providerRefundId ?? explicitRowId ?? uid;
      // Prefer a distinct refund UID when present. Tochka snapshots can repeat
      // the parent payment operation id for multiple partial rows; treating it
      // as the identity would collapse equal refunds and under-claw the user.
      const id = uid ?? fallbackId;
      if (!id || seen.has(id)) {
        // If two rows have no distinct stable identity, fail closed so the
        // snapshot remains eligible for a later, richer provider response.
        if (id && seen.has(id)) return [];
        continue;
      }
      const rawRowStatus = statusFrom(entry, entry);
      const providerStatus = rawRowStatus || topStatus;
      const disposition = refundDisposition(providerStatus);
      if (!disposition) continue;
      seen.add(id);
      const amountRub = numberField(entry, 'amount', 'Amount', 'refundAmount', 'refundedAmount');
      if (topStatus === 'REFUNDED_PARTIALLY' && amountRub == null) return [];
      if (amountRub == null) missingAmount = true;
      observations.push({
        id,
        disposition,
        providerStatus,
        ...(amountRub != null ? { amountRub } : {}),
        ...(uid ? { refundUid: uid } : {}),
        ...(providerRefundId && providerRefundId !== id ? { providerRefundId } : {}),
      });
    }
    if (observations.length > 1 && missingAmount) return [];
    if (observations.length > 0) return observations;
  }

  const disposition = refundDisposition(topStatus);
  // A plain payment status (APPROVED/PAID/etc.) is not a refund observation.
  if (
    !disposition ||
    ![
      'REFUNDED',
      'REFUNDED_PARTIALLY',
      'WAITING',
      'ON-REFUND',
      'ON_REFUND',
      'PENDING',
      'PROCESSING',
      'REJECTED',
      'DECLINED',
      'FAILED',
      'CANCELED',
      'CANCELLED',
    ].includes(topStatus)
  ) {
    return [];
  }
  const uid = providerRefundUid(operation, payload);
  // A non-final status may omit the refund UID. It is still safe to observe it
  // when the caller has exactly one pending ledger row; recordRefundObservation
  // performs that cardinality check before changing state. Partial final
  // responses, however, must never fall back to the parent payment id.
  if (!uid && topStatus === 'REFUNDED_PARTIALLY') return [];
  const amountRub =
    topStatus === 'REFUNDED'
      ? (numberField(operation, 'refundAmount', 'refundedAmount', 'amount') ?? orderAmountRub)
      : numberField(operation, 'refundAmount', 'refundedAmount', 'refund_amount');
  if (topStatus === 'REFUNDED_PARTIALLY' && amountRub == null) return [];
  return [
    {
      id: uid ?? paymentId,
      disposition,
      providerStatus: topStatus,
      ...(amountRub != null ? { amountRub } : {}),
      ...(uid ? { refundUid: uid } : {}),
    },
  ];
}

/**
 * Tochka exposes each confirmed partial refund in `Data.Operation[0].Order[]`.
 * A row's provider order id is the idempotency anchor; the payment id is never
 * used as a fallback for a partial response because that would collapse two
 * equal partial refunds into one clawback. Full responses may safely fall back
 * to the payment id when the provider omits refund rows.
 */
export function extractTochkaRefundOperations(
  payload: Record<string, unknown>,
  paymentId: string,
  orderAmountRub: number,
): TochkaRefundOperation[] {
  const operation = operationFrom(payload);
  const status = statusFrom(payload, operation);
  if (status !== 'REFUNDED' && status !== 'REFUNDED_PARTIALLY') return [];

  const rows = operation.Order ?? operation.order;
  if (Array.isArray(rows)) {
    const refunds: TochkaRefundOperation[] = [];
    const seen = new Set<string>();
    let missingAmount = false;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const entry = row as Record<string, unknown>;
      const type = String(entry.type ?? entry.Type ?? '').toLowerCase();
      if (type !== 'refund') continue;
      const uid = stringField(entry, 'refundUid', 'RefundUid', 'refundId', 'RefundId');
      const providerRefundId = stringField(
        entry,
        'providerRefundId',
        'ProviderRefundId',
        'refundOperationId',
        'RefundOperationId',
        'orderId',
        'OrderId',
      );
      const explicitRowId = stringField(entry, 'id', 'Id');
      const fallbackId = providerRefundId ?? explicitRowId ?? uid;
      const id = uid ?? fallbackId;
      if (!id || seen.has(id)) {
        if (id && seen.has(id)) return [];
        continue;
      }
      seen.add(id);
      const amountRub = numberField(entry, 'amount', 'Amount', 'refundAmount', 'refundedAmount');
      if (status === 'REFUNDED_PARTIALLY' && amountRub == null) return [];
      if (amountRub == null) missingAmount = true;
      refunds.push({
        id,
        ...(amountRub != null ? { amountRub } : {}),
        ...(uid ? { refundUid: uid } : {}),
        ...(providerRefundId && providerRefundId !== id ? { providerRefundId } : {}),
      });
    }
    if (refunds.length > 1 && missingAmount) return [];
    if (refunds.length > 0) return refunds;
  }

  const amount =
    status === 'REFUNDED'
      ? (numberField(operation, 'refundAmount', 'refundedAmount', 'amount') ?? orderAmountRub)
      : numberField(operation, 'refundAmount', 'refundedAmount', 'refund_amount');
  if (amount == null) return [];
  const uid = providerRefundUid(operation, payload);
  if (status === 'REFUNDED_PARTIALLY' && !uid) return [];
  return [{ id: uid ?? paymentId, amountRub: amount, ...(uid ? { refundUid: uid } : {}) }];
}

async function dropResolvedRefundEvent(
  paymentId: string,
  refund: TochkaRefundOperation,
  key: string,
): Promise<void> {
  const ids = [key, refund.id, refund.refundUid].filter((value): value is string => !!value);
  await db
    .delete(billingUnresolvedEvents)
    .where(
      and(
        eq(billingUnresolvedEvents.event, 'tochka.refund'),
        inArray(billingUnresolvedEvents.objectId, ids),
        or(
          eq(billingUnresolvedEvents.pspPaymentId, paymentId),
          eq(billingUnresolvedEvents.objectId, key),
        ),
      ),
    );
  // A refund snapshot also proves the original payment is no longer awaiting
  // settlement. Remove only the exact acquiring event for this payment; never
  // use a payment-wide delete that could erase another refund's unresolved row.
  await db
    .delete(billingUnresolvedEvents)
    .where(
      and(
        inArray(billingUnresolvedEvents.event, [
          'acquiringInternetPayment',
          'tochka.acquiringInternetPayment',
        ]),
        eq(billingUnresolvedEvents.pspPaymentId, paymentId),
      ),
    );
}

/**
 * Remove the provisional event parked by a refund webhook that had only a
 * paymentLinkId. The predicate is deliberately exact: an unrelated refund
 * for another order or a provider-bound event must remain retained.
 */
async function dropUnboundRefundEvent(orderRef: string, status: string): Promise<void> {
  await db
    .delete(billingUnresolvedEvents)
    .where(
      and(
        eq(billingUnresolvedEvents.event, 'tochka.refund'),
        eq(billingUnresolvedEvents.objectId, tochkaUnboundRefundEventKey(orderRef, status)),
        eq(billingUnresolvedEvents.orderRef, orderRef),
        isNull(billingUnresolvedEvents.pspPaymentId),
      ),
    );
}

function datePart(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function lexicographicAfter(createdAt: string | undefined, id: string | undefined) {
  if (!createdAt || !id) return undefined;
  // PostgreSQL timestamps retain microseconds while the node-postgres Date
  // parser truncates them to milliseconds. Keep the exact database value as
  // text for the cursor, otherwise a one-row page can return the same row
  // forever when its stored timestamp is a few microseconds after the Date
  // value sent back by the driver.
  const cursor = sql`${createdAt}::timestamptz`;
  return or(gt(orders.createdAt, cursor), and(eq(orders.createdAt, cursor), gt(orders.id, id)));
}

async function refundRowsForOrder(orderId: string) {
  return db
    .select({ amountRub: billingRefunds.amountRub, status: billingRefunds.status })
    .from(billingRefunds)
    .where(eq(billingRefunds.orderId, orderId));
}

async function recordRefundObservation(
  candidate: ReconcileCandidate,
  paymentId: string,
  observation: RefundObservation,
): Promise<RefundLedgerRow | null> {
  const ids = [
    observation.refundUid,
    observation.providerRefundId,
    // The parent payment id is used as the fallback id for a full final
    // snapshot. Never query it as a refund identity: it is not unique across
    // partial operations and could bind an unrelated row.
    observation.id !== paymentId ? observation.id : undefined,
  ].filter((value): value is string => Boolean(value));
  let rows =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(billingRefunds)
          .where(
            and(
              eq(billingRefunds.psp, 'tochka'),
              eq(billingRefunds.orderId, candidate.id),
              eq(billingRefunds.pspPaymentId, paymentId),
              or(
                inArray(billingRefunds.refundUid, ids),
                inArray(billingRefunds.providerRefundId, ids),
              ),
            ),
          );
  // Some Tochka status snapshots omit the refund UID. If there is exactly one
  // pending request for this payment, its state can still be resolved safely;
  // with multiple pending partials we leave them untouched rather than guess.
  if (rows.length === 0 && ['confirmed', 'pending', 'rejected'].includes(observation.disposition)) {
    const pending = await db
      .select()
      .from(billingRefunds)
      .where(
        and(
          eq(billingRefunds.psp, 'tochka'),
          eq(billingRefunds.orderId, candidate.id),
          eq(billingRefunds.pspPaymentId, paymentId),
          eq(billingRefunds.status, 'pending'),
        ),
      );
    if (pending.length === 1) rows = pending;
  }
  if (rows.length === 0) return null;
  for (const row of rows) {
    if (observation.disposition === 'rejected' && row.status === 'pending') {
      await db
        .update(billingRefunds)
        .set({
          status: 'rejected',
          providerStatus: observation.providerStatus,
          lastError: `provider status ${observation.providerStatus}`,
          updatedAt: new Date(),
        })
        .where(and(eq(billingRefunds.id, row.id), eq(billingRefunds.status, 'pending')));
    } else if (observation.disposition === 'pending' && row.status === 'pending') {
      await db
        .update(billingRefunds)
        .set({ providerStatus: observation.providerStatus, updatedAt: new Date() })
        .where(and(eq(billingRefunds.id, row.id), eq(billingRefunds.status, 'pending')));
    }
  }
  return rows[0] ?? null;
}

async function processPaymentSnapshot(
  candidate: ReconcileCandidate,
  paymentId: string,
  snapshot: Record<string, unknown>,
  opts: TochkaRefundReconciliationOptions,
  counters: { refunded: number; clawedBack: number; failures: number },
): Promise<void> {
  const status = statusFrom(snapshot, operationFrom(snapshot));
  if (['APPROVED', 'COMPLETED', 'SUCCEEDED', 'PAID'].includes(status)) {
    if (candidate.ourStatus === 'pending') {
      try {
        await opts.beforeProviderCall?.();
        await _billingShared.applyPaymentSucceeded(paymentId, candidate.id, {
          retrievePayment: async (providerPaymentId) => {
            await opts.beforeProviderCall?.();
            const verified = await opts.provider.getPaymentInfo(providerPaymentId);
            await opts.beforeProviderCall?.();
            const verifiedOperation = operationFrom(verified);
            const verifiedStatus = statusFrom(verified, verifiedOperation);
            return {
              status: ['APPROVED', 'COMPLETED', 'SUCCEEDED', 'PAID'].includes(verifiedStatus)
                ? 'succeeded'
                : verifiedStatus.toLowerCase(),
              amountRub: numberField(verifiedOperation, 'amount', 'amountRub') ?? null,
            };
          },
        });
      } catch (error) {
        if (error instanceof LeaderLeaseLostError) throw error;
        counters.failures++;
        tochkaReconciliationFailuresTotal.labels('payment_settlement').inc();
        opts.log?.warn(
          { err: error, orderId: candidate.id, paymentId },
          'tochka reconciliation: payment settlement failed',
        );
      }
    }
  }

  const observations = observeTochkaRefunds(snapshot, paymentId, candidate.amountRub);
  const matchedLedgerRows = new Map<string, RefundLedgerRow>();
  for (const observation of observations) {
    const matched = await recordRefundObservation(candidate, paymentId, observation);
    if (matched) matchedLedgerRows.set(observation.id, matched);
  }
  let allConfirmedRefundsApplied = observations.length > 0;
  for (const refund of observations.filter(({ disposition }) => disposition === 'confirmed')) {
    const matched = matchedLedgerRows.get(refund.id);
    // A legacy final snapshot may omit the refund UID. If exactly one pending
    // request matched it, reuse that row's UID instead of creating a second
    // operation under the parent payment id. A conflicting amount is retained
    // for investigation rather than guessing which operation settled.
    if (
      !refund.refundUid &&
      matched &&
      refund.amountRub != null &&
      Number(matched.amountRub) !== refund.amountRub
    ) {
      allConfirmedRefundsApplied = false;
      counters.failures++;
      tochkaReconciliationFailuresTotal.labels('refund_identity').inc();
      opts.log?.warn(
        {
          orderId: candidate.id,
          paymentId,
          refundId: refund.id,
          requestedRub: matched.amountRub,
          providerRub: refund.amountRub,
        },
        'tochka reconciliation: refund amount changed without a stable UID',
      );
      continue;
    }
    const refundUid = refund.refundUid ?? matched?.refundUid ?? refund.id;
    const reversalKey = `clawback:tochka:${paymentId}:${refund.id}`;
    const [existing] = await db
      .select({ status: billingRefunds.status })
      .from(billingRefunds)
      .where(and(eq(billingRefunds.psp, 'tochka'), eq(billingRefunds.refundUid, refundUid)))
      .limit(1);
    if (existing?.status === 'applied') continue;
    try {
      await opts.beforeProviderCall?.();
      const reversal: TochkaRefundReversal = {
        paymentId,
        orderRef: candidate.id,
        reversalKey,
        refundUid,
        providerRefundId: refund.providerRefundId ?? matched?.providerRefundId ?? refund.id,
        providerStatus: status,
        newStatus: 'refunded',
        ...(refund.amountRub != null ? { refundedRub: refund.amountRub } : {}),
      };
      const out = await reversePaymentGrant(reversal);
      if (!('clawedBack' in out)) {
        allConfirmedRefundsApplied = false;
        counters.failures++;
        opts.log?.warn(
          { orderId: candidate.id, paymentId, refundId: refund.id },
          'tochka reconciliation: refund no longer maps to candidate order',
        );
        continue;
      }
      counters.refunded++;
      counters.clawedBack += out.clawedBack;
      await dropResolvedRefundEvent(paymentId, refund, reversalKey).catch((error) => {
        opts.log?.warn(
          { err: error, paymentId, refundId: refund.id },
          'tochka reconciliation: refund event cleanup failed',
        );
      });
      opts.log?.info(
        { orderId: candidate.id, paymentId, refundId: refund.id, result: out },
        'tochka reconciliation: refund applied',
      );
    } catch (error) {
      if (error instanceof LeaderLeaseLostError) throw error;
      allConfirmedRefundsApplied = false;
      counters.failures++;
      tochkaReconciliationFailuresTotal.labels('refund_apply').inc();
      opts.log?.error(
        { err: error, orderId: candidate.id, paymentId, refundId: refund.id },
        'tochka reconciliation: refund apply failed',
      );
    }
  }

  // A refund event parked before the PSP operation id was known is a single
  // durable reminder for this order/status. Remove it only after every
  // confirmed operation in the provider snapshot has been applied; retaining
  // it on a partial failure keeps the recovery signal alive without deleting
  // unrelated unresolved events.
  const orderRef =
    typeof candidate.metadata?.paymentLinkId === 'string' && candidate.metadata.paymentLinkId
      ? candidate.metadata.paymentLinkId
      : candidate.id;
  if (
    allConfirmedRefundsApplied &&
    observations.length > 0 &&
    observations.every(({ disposition }) => disposition === 'confirmed') &&
    (status === 'REFUNDED' || status === 'REFUNDED_PARTIALLY')
  ) {
    await dropUnboundRefundEvent(orderRef, status).catch((error) => {
      opts.log?.warn(
        { err: error, orderId: candidate.id, paymentId },
        'tochka reconciliation: provisional refund event cleanup failed',
      );
    });
  }
}

/**
 * Reconcile provider state with durable keyset pagination. There is no fixed
 * lookback: a captured payment remains a candidate until its refund ledger is
 * fully applied. Pagination uses `(createdAt,id)` so a busy account with more
 * than one batch cannot starve its oldest refund.
 */
export async function reconcileTochkaRefunds(
  opts: TochkaRefundReconciliationOptions,
): Promise<TochkaRefundReconciliationResult> {
  const now = opts.now ?? new Date();
  const batchSize = Math.min(100, positiveInt(opts.batchSize, DEFAULT_BATCH_SIZE));
  const log = opts.log ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const candidates: ReconcileCandidate[] = [];
  let cursorCreatedAt: string | undefined;
  let cursorId: string | undefined;
  while (true) {
    const rows = await db
      .select({
        id: orders.id,
        userId: orders.userId,
        kind: orders.kind,
        amountRub: orders.amountRub,
        pspPaymentId: orders.pspPaymentId,
        metadata: orders.metadata,
        createdAt: orders.createdAt,
        createdAtCursor: sql<string>`${orders.createdAt}::text`,
        ourStatus: orders.ourStatus,
      })
      .from(orders)
      .where(
        and(
          eq(orders.psp, 'tochka'),
          or(
            inArray(orders.ourStatus, ['pending', 'paid', 'partially_refunded', 'refunded']),
            and(
              eq(orders.ourStatus, 'failed'),
              exists(
                db
                  .select({ id: billingRefunds.id })
                  .from(billingRefunds)
                  .where(
                    and(
                      eq(billingRefunds.orderId, orders.id),
                      inArray(billingRefunds.status, ['pending', 'confirmed']),
                    ),
                  ),
              ),
            ),
          ),
          lexicographicAfter(cursorCreatedAt, cursorId),
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orders.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    candidates.push(...(rows as ReconcileCandidate[]));
    const last = rows[rows.length - 1]!;
    cursorCreatedAt = last.createdAtCursor;
    cursorId = last.id;
    if (rows.length < batchSize) break;
  }

  let checked = 0;
  const counters = { refunded: 0, clawedBack: 0, failures: 0 };
  const unbound = candidates.filter((candidate) => !candidate.pspPaymentId);
  let operationList: TochkaOperation[] = [];
  if (unbound.length > 0 && opts.provider.getPaymentOperationList) {
    try {
      await opts.beforeProviderCall?.();
      const earliest = unbound.reduce(
        (min, candidate) => (candidate.createdAt < min ? candidate.createdAt : min),
        unbound[0]!.createdAt,
      );
      const list = await opts.provider.getPaymentOperationList(datePart(earliest), datePart(now));
      await opts.beforeProviderCall?.();
      operationList = operationsFrom(list);
    } catch (error) {
      if (error instanceof LeaderLeaseLostError) throw error;
      counters.failures += unbound.length;
      tochkaReconciliationFailuresTotal.labels('operation_list').inc(unbound.length);
      log.error({ err: error }, 'tochka reconciliation: operation list lookup failed');
    }
  } else if (unbound.length > 0) {
    counters.failures += unbound.length;
    tochkaReconciliationFailuresTotal.labels('operation_list_unavailable').inc(unbound.length);
    log.error(
      { count: unbound.length },
      'tochka reconciliation: provider cannot list operations for unbound payments',
    );
  }

  for (const candidate of candidates) {
    // A fully applied refund is terminal and does not need another provider
    // request. This also lets the loop converge to checked=0 after a tick.
    const localRefunds = await refundRowsForOrder(candidate.id);
    const appliedCents = localRefunds
      .filter((row) => row.status === 'applied')
      .reduce((sum, row) => sum + rubCents(Number(row.amountRub)), 0);
    if (candidate.ourStatus === 'refunded' && appliedCents >= rubCents(candidate.amountRub))
      continue;

    let paymentId = candidate.pspPaymentId;
    let snapshot: Record<string, unknown> | undefined;
    if (paymentId) {
      checked++;
      try {
        await opts.beforeProviderCall?.();
        snapshot = await opts.provider.getPaymentInfo(paymentId);
        await opts.beforeProviderCall?.();
      } catch (error) {
        if (error instanceof LeaderLeaseLostError) throw error;
        counters.failures++;
        tochkaReconciliationFailuresTotal.labels('payment_lookup').inc();
        log.warn(
          { err: error, orderId: candidate.id, paymentId },
          'tochka reconciliation: payment lookup failed',
        );
        continue;
      }
    } else {
      const metadata = candidate.metadata ?? {};
      const paymentLinkId =
        (typeof metadata.paymentLinkId === 'string' && metadata.paymentLinkId) || candidate.id;
      const operation = operationList.find((row) => operationPaymentLinkId(row) === paymentLinkId);
      if (!operation) continue;
      paymentId = operationPaymentId(operation) ?? null;
      if (!paymentId) continue;
      checked++;
      snapshot = { Data: { Operation: [operation] } };
    }
    if (!snapshot || !paymentId) continue;
    await processPaymentSnapshot(candidate, paymentId, snapshot, { ...opts, log }, counters);
  }

  // Provider agreements are independent resources. Any local cancellation,
  // expiry, or scheduled cancellation must converge to provider `Cancelled`;
  // failures are retried on the next tick. No creation-date cutoff applies.
  let cancelCursorCreatedAt: string | undefined;
  let cancelCursorId: string | undefined;
  let providerCancellations = 0;
  while (true) {
    const after =
      cancelCursorCreatedAt && cancelCursorId
        ? or(
            gt(subscriptions.createdAt, sql`${cancelCursorCreatedAt}::timestamptz`),
            and(
              eq(subscriptions.createdAt, sql`${cancelCursorCreatedAt}::timestamptz`),
              gt(subscriptions.id, cancelCursorId),
            ),
          )
        : undefined;
    const canceledSubscriptions = await db
      .select({
        id: subscriptions.id,
        pspSubscriptionId: subscriptions.pspSubscriptionId,
        createdAt: subscriptions.createdAt,
        createdAtCursor: sql<string>`${subscriptions.createdAt}::text`,
      })
      .from(subscriptions)
      .where(
        and(
          isNotNull(subscriptions.pspSubscriptionId),
          or(
            inArray(subscriptions.status, ['canceled', 'expired']),
            and(
              inArray(subscriptions.status, ['active', 'trialing', 'past_due']),
              eq(subscriptions.cancelAtPeriodEnd, true),
            ),
          ),
          after,
        ),
      )
      .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id))
      .limit(batchSize);
    if (canceledSubscriptions.length === 0) break;
    for (const subscription of canceledSubscriptions) {
      const providerSubscriptionId = subscription.pspSubscriptionId;
      if (!providerSubscriptionId) continue;
      try {
        await opts.beforeProviderCall?.();
        const statusPayload = await opts.provider.getSubscriptionStatus(providerSubscriptionId);
        await opts.beforeProviderCall?.();
        const status = statusFrom(statusPayload, operationFrom(statusPayload)).replace(/[-_]/g, '');
        if (status === 'CANCELLED' || status === 'CANCELED') continue;
        await opts.beforeProviderCall?.();
        await opts.provider.setSubscriptionStatus(providerSubscriptionId, 'Cancelled');
        await opts.beforeProviderCall?.();
        providerCancellations++;
      } catch (error) {
        if (error instanceof LeaderLeaseLostError) throw error;
        counters.failures++;
        tochkaReconciliationFailuresTotal.labels('subscription_cancel').inc();
        log.error(
          { err: error, subscriptionId: subscription.id },
          'tochka reconciliation: provider subscription cancellation failed',
        );
      }
    }
    const last = canceledSubscriptions[canceledSubscriptions.length - 1]!;
    cancelCursorCreatedAt = last.createdAtCursor;
    cancelCursorId = last.id;
    if (canceledSubscriptions.length < batchSize) break;
  }

  return {
    checked,
    refunded: counters.refunded,
    clawedBack: counters.clawedBack,
    providerCancellations,
    failures: counters.failures,
  };
}

class LeaderLeaseLostError extends Error {
  constructor() {
    super('tochka reconciliation leader lease lost');
    this.name = 'LeaderLeaseLostError';
  }
}

export function startTochkaRefundReconciliation(opts: {
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  redis: IORedis;
  provider?: ReconciliationProvider;
  intervalMs?: number;
  firstTickDelayMs?: number;
  lookbackMs?: number;
  batchSize?: number;
  leaderKey?: string;
}): TochkaRefundReconciliationHandle {
  const intervalMs = Math.max(
    1_000,
    positiveInt(
      opts.intervalMs ?? process.env.TOCHKA_REFUND_RECONCILIATION_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    ),
  );
  const batchSize = Math.min(
    100,
    positiveInt(
      opts.batchSize ?? process.env.TOCHKA_REFUND_RECONCILIATION_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
    ),
  );
  const firstDelay = Math.max(0, opts.firstTickDelayMs ?? 5_000);
  const leaderKey = opts.leaderKey ?? LEADER_KEY;
  const instanceId = randomUUID();
  const provider = opts.provider ?? createTochkaProvider();
  let stopped = false;

  async function renewLease(lockTtl: number): Promise<boolean> {
    try {
      if (typeof opts.redis.eval === 'function') {
        const result = await opts.redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
          1,
          leaderKey,
          instanceId,
          String(lockTtl),
        );
        return Number(result) === 1;
      }
      // A bare PEXPIRE cannot prove that this process still owns the key; it
      // could extend a successor's lease after a failover. Refuse provider
      // work when the token-checked Lua primitive is unavailable.
      return false;
    } catch {
      return false;
    }
  }

  async function tick(): Promise<TochkaRefundReconciliationResult> {
    const lockTtl = Math.max(1_000, Math.floor(intervalMs * 2));
    const acquired = await opts.redis.set(leaderKey, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') {
      return { checked: 0, refunded: 0, clawedBack: 0, providerCancellations: 0, failures: 0 };
    }
    let leaseValid = true;
    const renew = async () => {
      if (!leaseValid) return;
      leaseValid = await renewLease(lockTtl);
    };
    const heartbeat = setInterval(() => void renew(), Math.max(250, Math.floor(lockTtl / 3)));
    try {
      const reconciliation: TochkaRefundReconciliationOptions = {
        provider,
        log: opts.log,
        batchSize,
        beforeProviderCall: async () => {
          await renew();
          if (!leaseValid) throw new LeaderLeaseLostError();
        },
      };
      return await reconcileTochkaRefunds(reconciliation);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function loop(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, firstDelay));
    while (!stopped) {
      try {
        const result = await tick();
        if (result.failures === 0) tochkaReconciliationLastSuccess.set(Date.now() / 1000);
        if (result.failures > 0) {
          tochkaReconciliationFailuresTotal.labels('tick').inc(result.failures);
        }
        if (result.checked > 0 || result.refunded > 0 || result.failures > 0) {
          opts.log.info({ ...result }, 'tochka reconciliation: tick complete');
        }
      } catch (error) {
        tochkaReconciliationFailuresTotal.labels('tick_exception').inc();
        opts.log.error({ err: error }, 'tochka reconciliation: tick failed');
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, batchSize }, 'tochka reconciliation started');
  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
